import axios from 'axios';
import bodyParser from 'body-parser';
import Express, { NextFunction, Request, Response } from 'express';
import slowDown from 'express-slow-down';

import fs from 'fs';
import path from 'path';

// [webhook id]: reset time
const ratelimits: { [id: string]: number } = {};

const app = Express();
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8')) as { port: number; trustProxy: boolean };
const blocked = JSON.parse(fs.readFileSync('./blocklist.json', 'utf-8')) as { [id: string]: string };

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

const client = axios.create({
    validateStatus: () => true
});

app.get('/', (req, res) => {
    return res.sendFile(path.resolve('index.html'));
});

app.post('/api/webhooks/:id/:token', webhookPostRatelimit, webhookInvalidPostRatelimit, async (req, res) => {
    const wait = req.query.wait ?? false;
    const threadId = req.query.thread_id;

    const body = req.body;

    if (blocked[req.params.id]) {
        return res.status(403).json({
            proxy: true,
            message: 'This webhook has been blocked. Please contact @Lewis_Schumer on the DevForum.',
            reason: blocked[req.params.id]
        });
    }

    // if we know this webhook is already ratelimited, don't hit discord but reject the request instead
    const ratelimit = ratelimits[req.params.id];
    if (ratelimit) {
        if (ratelimit < Date.now() / 1000) {
            delete ratelimits[req.params.id];
        } else {
            console.log(`${req.params.id} hit ratelimit`);

            res.setHeader('X-RateLimit-Limit', 5);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', ratelimit);

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

    // process ratelimits
    if (parseInt(response.headers['x-ratelimit-remaining']) === 0) {
        ratelimits[req.params.id] = parseInt(response.headers['x-ratelimit-reset']);
    }

    // forward headers to allow clients to process ratelimits themselves
    for (const header of Object.keys(response.headers)) {
        res.setHeader(header, response.headers[header]);
    }

    res.setHeader('Via', '1.0 WebhookProxy');

    return res.status(response.status).json(response.data);
});

app.use(unknownEndpointRatelimit, (req, res, next) => {
    return res.status(404).json({
        proxy: true,
        message: 'Unknown endpoint.'
    });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err);

    return res.status(500).json({
        proxy: true,
        message: 'An error occurred while processing your request.'
    });
});

app.listen(config.port, () => {
    console.log('Up and running.');
});
