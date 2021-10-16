import axios from 'axios';
import bodyParser from 'body-parser';
import Express, { NextFunction, Request, Response } from 'express';
import slowDown from 'express-slow-down';
import Cache from 'node-cache';
import { BannedIP, BannedWebhook, PrismaClient } from '@prisma/client';
import amqp from 'amqplib';

import fs from 'fs';
import path from 'path';

import beforeShutdown from './beforeShutdown';
import { error, log, warn } from './log';

import 'express-async-errors';
import { setup } from './rmq';

const db = new PrismaClient();
beforeShutdown(async () => {
    await db.$disconnect();
});

const webhookBansCache = new Cache({ stdTTL: 60 * 60 * 24 });
const ipBansCache = new Cache({ stdTTL: 60 * 60 * 24 });

// [webhook id]: reset time
const ratelimits: { [id: string]: number } = {};

// [webhook id]: count
const violations: { [id: string]: { count: number; expires: number } } = {};

// [webhook id]: expiry
const badRequests: { [id: string]: { count: number; expires: number } } = {};

// [ip]: count
const badWebhooks: { [ip: string]: { count: number; expires: number } } = {};

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
};

let rabbitMq: amqp.Channel;

if (config.autoBlock) {
    setInterval(async () => {
        const blocks = [];

        for (const [k, v] of Object.entries(violations)) {
            if (v.expires < Date.now() / 1000) {
                delete violations[k];
                continue;
            }

            if (v.count > 50) {
                // whilst this should never happen, we'll upsert anyway
                blocks.push(
                    db.bannedWebhook.upsert({
                        where: {
                            id: k
                        },
                        create: {
                            id: k,
                            reason: '[Automated] Ratelimited >50 times within a minute.'
                        },
                        update: {
                            reason: '[Automated] Ratelimited >50 times within a minute.'
                        }
                    })
                );
                webhookBansCache.del(k);
                warn('blocked', k, 'for >50 ratelimit violations within 1 minute');
                delete violations[k];
            }
        }

        if (blocks.length > 0) {
            await db.$transaction(blocks);
        }
    }, 1000);

    setInterval(async () => {
        const blocks = [];

        for (const [k, v] of Object.entries(badRequests)) {
            if (v.expires < Date.now() / 1000) {
                delete badRequests[k];
                continue;
            }

            if (v.count > 50) {
                blocks.push(
                    db.bannedWebhook.upsert({
                        where: {
                            id: k
                        },
                        create: {
                            id: k,
                            reason: '[Automated] >50 bad requests within 10 minutes.'
                        },
                        update: {
                            reason: '[Automated] >50 bad requests within 10 minutes.'
                        }
                    })
                );
                webhookBansCache.del(k);
                warn('blocked', k, 'for >50 bad requests within 10 minutes');
                delete badRequests[k];
            }
        }

        if (blocks.length > 0) {
            await db.$transaction(blocks);
        }
    }, 1000);

    setInterval(async () => {
        const blocks = [];

        for (const [k, v] of Object.entries(badWebhooks)) {
            if (v.expires < Date.now() / 1000) {
                delete badWebhooks[k];
                continue;
            }

            if (v.count > 5) {
                const expiry = new Date();
                expiry.setDate(expiry.getDate() + 3); // 3-day ban

                blocks.push(
                    db.bannedIP.upsert({
                        where: {
                            id: k
                        },
                        create: {
                            id: k,
                            reason: '[Automated] >5 unique non-existent webhook requests within 1 hour.',
                            expires: expiry
                        },
                        update: {
                            reason: '[Automated] >5 unique non-existent webhook requests within 1 hour.'
                        }
                    })
                );
                ipBansCache.del(k);
                warn('blocked', k, 'for >5 unique non-existent webhook requests within 1 hour');
                delete badRequests[k];
            }
        }

        if (blocks.length > 0) {
            await db.$transaction(blocks);
        }
    }, 1000);
}

async function getWebhookBanInfo(id: string) {
    if (webhookBansCache.has(id)) {
        return webhookBansCache.get<BannedWebhook>(id);
    }

    const ban = await db.bannedWebhook.findUnique({
        where: {
            id
        }
    });

    webhookBansCache.set(id, ban);

    return ban;
}

async function getIPBanInfo(id: string) {
    if (ipBansCache.has(id)) {
        return ipBansCache.get<BannedIP>(id);
    }

    const ban = await db.bannedIP.findUnique({
        where: {
            id
        }
    });

    ipBansCache.set(id, ban);

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
    }
});

const webhookQueuePostRatelimit = slowDown({
    windowMs: 1000,
    delayAfter: 10,
    delayMs: 1000,
    maxDelayMs: 30000,

    keyGenerator(req, res) {
        return req.params.id ?? req.ip; // use the webhook ID as a ratelimiting key, otherwise use IP
    }
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
    }
});

const unknownEndpointRatelimit = slowDown({
    windowMs: 10000,
    delayAfter: 5,
    delayMs: 500,
    maxDelayMs: 30000
});

const statsEndpointRatelimit = slowDown({
    windowMs: 5000,
    delayAfter: 1,
    delayMs: 500,
    maxDelayMs: 30000
});

const client = axios.create({
    validateStatus: () => true
});

app.use(Express.static('public'));

app.get('/stats', statsEndpointRatelimit, async (req, res) => {
    const stats = await db.stats.findUnique({
        where: {
            name: 'requests'
        }
    });

    return res.json({
        requests: stats?.value ?? 0,
        webhooks: await db.webhooksSeen.count()
    });
});

app.post('/api/webhooks/:id/:token', webhookPostRatelimit, webhookInvalidPostRatelimit, async (req, res) => {
    db.stats
        .upsert({
            where: {
                name: 'requests'
            },
            update: {
                value: {
                    increment: 1
                }
            },
            create: {
                name: 'requests',
                value: 1
            }
        })
        .then()
        .catch(e => warn('failed to update stats', e));

    const ipBan = await getIPBanInfo(req.ip);
    if (ipBan) {
        const expiry = Math.floor(ipBan.expires.getTime() / 1000);

        if (expiry < Date.now() / 1000) {
            await db.bannedIP.delete({
                where: {
                    id: ipBan.id
                }
            });
            ipBansCache.del(ipBan.id);
        } else {
            warn('ip', req.ip, 'attempted to request to', req.params.id, 'whilst banned');
            return res.status(403).json({
                proxy: true,
                message: 'This IP address has been banned.',
                reason: ipBan.reason,
                expires: expiry
            });
        }
    }

    const wait = req.query.wait ?? false;
    const threadId = req.query.thread_id;

    const body = req.body;

    const banInfo = await getWebhookBanInfo(req.params.id);
    if (banInfo) {
        warn(req.params.id, 'attempted to request whilst blocked for', banInfo.reason);
        return res.status(403).json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @Lewis_Schumer on the DevForum.',
            reason: banInfo.reason
        });
    }

    // if we know this webhook is already ratelimited, don't hit discord but reject the request instead
    const ratelimit = ratelimits[req.params.id];
    if (ratelimit) {
        if (ratelimit < Date.now() / 1000) {
            delete ratelimits[req.params.id];
        } else {
            res.setHeader('X-RateLimit-Limit', 5);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', ratelimit);

            violations[req.params.id] ??= { count: 0, expires: Date.now() / 1000 + 60 };
            violations[req.params.id].count++;

            warn(
                req.params.id,
                'hit ratelimit, they have done so',
                violations[req.params.id].count,
                'times within the window'
            );

            return res.status(429).json({
                proxy: true,
                message: 'You have been ratelimited. Please respect the standard Discord ratelimits.'
            });
        }
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

        badWebhooks[req.ip] ??= { count: 0, expires: Date.now() / 1000 + 3600 };
        badWebhooks[req.ip].count++;

        warn(
            req.ip,
            'made a request to a nonexistent webhook, they have made',
            badWebhooks[req.ip].count,
            'within the window'
        );

        return res.status(404).json({
            proxy: true,
            error: 'This webhook does not exist.'
        });
    }

    db.webhooksSeen
        .upsert({
            where: {
                id: req.params.id
            },
            create: {
                id: req.params.id
            },
            update: {}
        })
        .then();

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        badRequests[req.params.id] ??= { count: 0, expires: Date.now() / 1000 + 600 };
        badRequests[req.params.id].count++;
        warn(
            req.params.id,
            'made a bad request, they have made',
            badRequests[req.params.id].count,
            'within the window'
        );
    }

    if (parseInt(response.headers['x-ratelimit-remaining']) === 0) {
        // process ratelimits
        ratelimits[req.params.id] = parseInt(response.headers['x-ratelimit-reset']);
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
        const expiry = Math.floor(ipBan.expires.getTime() / 1000);

        if (expiry < Date.now() / 1000) {
            await db.bannedIP.delete({
                where: {
                    id: ipBan.id
                }
            });
            ipBansCache.del(ipBan.id);
        } else {
            warn('ip', req.ip, 'attempted to queue to', req.params.id, 'whilst banned');
            return res.status(403).json({
                proxy: true,
                message: 'This IP address has been banned.',
                reason: ipBan.reason,
                expires: expiry
            });
        }
    }

    const threadId = req.query.thread_id;

    const body = req.body;

    const banInfo = await getWebhookBanInfo(req.params.id);
    if (banInfo) {
        warn(req.params.id, 'attempted to queue whilst blocked for', banInfo.reason);
        return res.status(403).json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @Lewis_Schumer on the DevForum.',
            reason: banInfo.reason
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
    error('error encountered:', err);

    return res.status(500).json({
        proxy: true,
        message: 'An error occurred while processing your request.'
    });
});

app.listen(config.port, async () => {
    log('Up and running.');

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
