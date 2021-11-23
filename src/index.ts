import axios from 'axios';
import bodyParser from 'body-parser';
import Express, { NextFunction, Request, Response } from 'express';
import slowDown from 'express-slow-down';
import RedisStore from 'rate-limit-redis';
import { PrismaClient } from '@prisma/client';
import amqp from 'amqplib';
import Redis from 'ioredis';

import fs from 'fs';

import beforeShutdown from './beforeShutdown';
import { error, log, warn } from './log';

import 'express-async-errors';
import { setup } from './rmq';
import { info } from 'console';

const VERSION = (() => {
    const rev = fs.readFileSync('.git/HEAD').toString().trim();
    if (rev.indexOf(':') === -1) {
        return rev;
    } else {
        return fs
            .readFileSync('.git/' + rev.substring(5))
            .toString()
            .trim()
            .slice(0, 7);
    }
})();

const app = Express();
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8')) as {
    port: number;
    trustProxy: boolean;
    autoBlock: boolean;
    queue: {
        enabled: boolean;
        rabbitmq: string;
        queue: string;
    };
    redis: string;
};

const db = new PrismaClient();
const redis = new Redis(config.redis);
beforeShutdown(async () => {
    await db.$disconnect();
    redis.disconnect(false);
});

let rabbitMq: amqp.Channel;

let requestsHandled = 0;

async function banWebhook(id: string, reason: string) {
    // set the cached version up first so we prevent race conditions.
    //
    // without setting the cache first, we might hit a point where two requests trigger a ban.
    // setting it in cache first will prevent this since it will read the cached version first,
    // realise that they're banned, and stop the request there.
    await redis.set(`webhookBan:${id}`, reason, 'EX', 24 * 60 * 60);
    await db.bannedWebhook.upsert({
        where: {
            id
        },
        create: {
            id,
            reason
        },
        update: {
            reason
        }
    });

    warn('banned', id, 'for', reason);
}

async function banIp(ip: string, reason: string) {
    // see justification above for setting cache first
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 3); // 3-day ban

    await redis.set(`ipBan:${ip}`, reason, 'PXAT', expiry.getTime());
    await db.bannedIP.upsert({
        where: {
            id: ip
        },
        create: {
            id: ip,
            reason,
            expires: expiry
        },
        update: {
            reason
        }
    });

    warn('banned', ip, 'for', reason);
}

async function trackRatelimitViolation(id: string) {
    const violations = await redis.incr(`webhookRatelimit:${id}`);
    await redis.send_command('EXPIRE', [`webhookRatelimit:${id}`, 60, 'NX']);

    warn(id, 'hit ratelimit, they have done so', violations, 'times within the window');

    if (violations > 50 && config.autoBlock) {
        await banWebhook(id, '[Automated] Ratelimited >50 times within a minute.');
        await redis.del(`webhookRatelimit:${id}`);
    }

    return violations;
}

async function trackBadRequest(id: string) {
    const violations = await redis.incr(`badRequests:${id}`);
    await redis.send_command('EXPIRE', [`badRequests:${id}`, 60 * 60, 'NX']);

    warn(id, 'made a bad request, they have made', violations, 'within the window');

    if (violations > 30 && config.autoBlock) {
        await banWebhook(id, '[Automated] >30 bad requests within 10 minutes.');
        await redis.del(`badRequests:${id}`);
    }

    return violations;
}

async function trackNonExistentWebhook(ip: string) {
    const violations = await redis.incr(`nonExistentWebhooks:${ip}`);
    await redis.send_command('EXPIRE', [`badRequests:${ip}`, 3600, 'NX']);

    warn(ip, 'made a request to a nonexistent webhook, they have made', violations, 'within the window');

    if (violations > 5 && config.autoBlock) {
        await banIp(ip, '[Automated] >5 unique non-existent webhook requests within 1 hour.');
        await redis.del(`nonExistentWebhooks:${ip}`);
    }

    return violations;
}

async function getWebhookBanInfo(id: string): Promise<string> {
    const data = await redis.get(`webhookBan:${id}`);
    if (data) {
        return data;
    }

    const ban = await db.bannedWebhook.findUnique({
        where: {
            id
        }
    });

    await redis.set(`webhookBan:${id}`, ban?.reason, 'EX', 24 * 60 * 60);

    return ban?.reason;
}

async function getIPBanInfo(id: string): Promise<{ reason: string; expires: Date }> {
    const data = await redis.get(`ipBan:${id}`);
    if (data) {
        const ban = JSON.parse(data);
        if (ban === null) return undefined;
        return { reason: ban.reason, expires: new Date(ban.expires) };
    }

    const ban = await db.bannedIP.findUnique({
        where: {
            id
        },
        select: {
            reason: true,
            expires: true
        }
    });

    if (ban) {
        if (ban.expires.getTime() <= Date.now()) {
            await db.bannedIP.delete({
                where: {
                    id
                }
            });
            await redis.del(`ipBan:${id}`);
            return undefined;
        }
    }

    await redis.set(
        `ipBan:${id}`,
        JSON.stringify(ban),
        'PXAT',
        ban?.expires.getTime() ?? Date.now() + 24 * 60 * 60 * 1000
    );

    return ban;
}

app.set('trust proxy', config.trustProxy);

app.use(
    require('helmet')({
        contentSecurityPolicy: false
    })
);
app.use(bodyParser.json());

// catch spammers that ignore ratelimits in a way that can cause servers to yield for long periods of time
const webhookPostRatelimit = slowDown({
    windowMs: 2000,
    delayAfter: 5,
    delayMs: 1000,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    },

    store: new RedisStore({ client: redis, prefix: 'ratelimit:webhookPost:' })
});

const webhookQueuePostRatelimit = slowDown({
    windowMs: 1000,
    delayAfter: 10,
    delayMs: 1000,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    },

    store: new RedisStore({ client: redis, prefix: 'ratelimit:webhookQueue:' })
});

const webhookInvalidPostRatelimit = slowDown({
    windowMs: 30000,
    delayAfter: 3,
    delayMs: 1000,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    },

    skip(req, res) {
        return !(res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429); // trigger if it's a 4xx but not a ratelimit
    },

    store: new RedisStore({ client: redis, prefix: 'ratelimit:webhookInvalidPost:' })
});

const unknownEndpointRatelimit = slowDown({
    windowMs: 10000,
    delayAfter: 5,
    delayMs: 500,
    maxDelayMs: 30000,

    store: new RedisStore({ client: redis, prefix: 'ratelimit:unknownEndpoint:' })
});

const statsEndpointRatelimit = slowDown({
    windowMs: 5000,
    delayAfter: 1,
    delayMs: 500,
    maxDelayMs: 30000,

    store: new RedisStore({ client: redis, prefix: 'ratelimit:statsEndpoint:' })
});

const client = axios.create({
    validateStatus: () => true
});

app.use(Express.static('public'));

app.get('/stats', statsEndpointRatelimit, async (req, res) => {
    const data = await Promise.all([
        db.webhooksSeen.count(),
        (async () => parseInt((await redis.get('stats:requests')) ?? '0'))()
    ]);

    return res.json({
        requests: data[0],
        webhooks: data[1],
        version: VERSION
    });
});

app.get('/announcement', async (req, res) => {
    const announcement = await redis.hgetall('announcement');

    if (!announcement.style) return res.json({});

    return res.json({
        title: announcement['title'],
        message: announcement['message'],
        style: announcement['style']
    });
});

app.post('/api/webhooks/:id/:token', webhookPostRatelimit, webhookInvalidPostRatelimit, async (req, res) => {
    redis.incr('stats:requests');
    requestsHandled++;

    try {
        BigInt(req.params.id);
    } catch {
        return res.status(400).json({
            proxy: true,
            error: 'Webhook ID does not appear to be a snowflake.'
        });
    }

    const ipBan = await getIPBanInfo(req.ip);
    if (ipBan) {
        warn('ip', req.ip, 'attempted to request to', req.params.id, 'whilst banned');
        return res.status(403).json({
            proxy: true,
            message: 'This IP address has been banned.',
            reason: ipBan.reason,
            expires: ipBan.expires.getTime()
        });
    }

    const wait = req.query.wait ?? false;
    const threadId = req.query.thread_id;

    const body = req.body;

    if (!body.content && !body.embeds && !body.file) {
        await trackBadRequest(req.params.id);

        return res.status(400).json({
            proxy: true,
            error: 'No body provided. The proxy only accepts valid JSON bodies.'
        });
    }

    const banInfo = await getWebhookBanInfo(req.params.id);
    if (banInfo) {
        warn(req.params.id, 'attempted to request whilst blocked for', banInfo);
        return res.status(403).json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @Lewis_Schumer on the DevForum.',
            reason: banInfo
        });
    }

    // if we know this webhook is already ratelimited, don't hit discord but reject the request instead
    const ratelimit = await redis.get(`webhookRatelimit:${req.params.id}`);
    if (ratelimit) {
        res.setHeader('X-RateLimit-Limit', 5);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', ratelimit);

        await trackRatelimitViolation(req.params.id);

        return res.status(429).json({
            proxy: true,
            message: 'You have been ratelimited. Please respect the standard Discord ratelimits.'
        });
    }

    const response = await client.post(
        `https://discord.com/api/webhooks/${req.params.id}/${req.params.token}?wait=${wait}${
            threadId ? '&thread_id=' + threadId : ''
        }`,
        body,
        {
            headers: {
                'User-Agent': 'WebhookProxy/1.0 (https://github.com/LewisTehMinerz/webhook-proxy)',
                'Content-Type': 'application/json'
            }
        }
    );

    if (response.status === 404) {
        await db.bannedWebhook.upsert({
            where: {
                id: req.params.id
            },
            create: {
                id: req.params.id,
                reason: '[Automated] Webhook does not exist.'
            },
            update: {
                reason: '[Automated] Webhook does not exist.'
            }
        });

        await trackNonExistentWebhook(req.ip);

        return res.status(404).json({
            proxy: true,
            error: 'This webhook does not exist.'
        });
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        await trackBadRequest(req.params.id);
    }

    if (parseInt(response.headers['x-ratelimit-remaining']) === 0) {
        // process ratelimits
        await redis.set(
            `webhookRatelimit:${req.params.id}`,
            parseInt(response.headers['x-ratelimit-reset']),
            'EXAT',
            parseInt(response.headers['x-ratelimit-reset'])
        );
    }

    // forward headers to allow clients to process ratelimits themselves
    for (const header of Object.keys(response.headers)) {
        res.setHeader(header, response.headers[header]);
    }

    res.setHeader('Via', '1.0 WebhookProxy');

    return res.status(response.status).json(response.data);
});

app.post('/api/webhooks/:id/:token/queue', webhookQueuePostRatelimit, async (req, res) => {
    if (!config.queue.enabled) return res.status(403).json({ proxy: true, error: 'Queues have been disabled.' });

    // run the same ban checks again so we don't hit ourselves if the webhook is bad

    const ipBan = await getIPBanInfo(req.ip);
    if (ipBan) {
        warn('ip', req.ip, 'attempted to queue to', req.params.id, 'whilst banned');
        return res.status(403).json({
            proxy: true,
            message: 'This IP address has been banned.',
            reason: ipBan.reason,
            expires: ipBan.expires.getTime()
        });
    }

    const threadId = req.query.thread_id;

    const body = req.body;

    const reason = await getWebhookBanInfo(req.params.id);
    if (reason) {
        warn(req.params.id, 'attempted to queue whilst blocked for', reason);
        return res.status(403).json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @Lewis_Schumer on the DevForum.',
            reason: reason
        });
    }

    rabbitMq.sendToQueue(
        config.queue.queue,
        Buffer.from(
            JSON.stringify({
                id: req.params.id,
                token: req.params.token,
                body,
                threadId: threadId as string
            })
        ),
        {
            persistent: true // make messages persistent to minimise lost messages
        }
    );

    return res.json({
        proxy: true,
        message: 'Queued successfully.'
    });
});

app.use(unknownEndpointRatelimit, (req, res, next) => {
    warn(req.ip, 'hit unknown endpoint');
    return res.status(404).json({
        proxy: true,
        message: 'Unknown endpoint.'
    });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
            proxy: true,
            error: 'Malformed request. The proxy only accepts valid JSON bodies.'
        });
    }

    error('error encountered:', err);

    return res.status(500).json({
        proxy: true,
        error: 'An error occurred while processing your request.'
    });
});

app.listen(config.port, async () => {
    log('Up and running. Version:', VERSION);

    setInterval(() => {
        info('In the last minute, this worker handled', requestsHandled, 'requests.');
        requestsHandled = 0;
    }, 60000);

    if (config.queue.enabled) {
        try {
            rabbitMq = await setup(config.queue.rabbitmq, config.queue.queue);

            beforeShutdown(async () => {
                await rabbitMq.close();
            });

            log('RabbitMQ set up.');
        } catch (e) {
            error('RabbitMQ init error, will disable queues:', e);
            config.queue.enabled = false;
        }
    }
});
