import amqp from 'amqplib';
import axios, { AxiosResponse } from 'axios';
import Redis from 'ioredis';

import fs from 'fs';

import beforeShutdown from './beforeShutdown';
import { error, log, warn } from './log';
import { setup } from './rmq';

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8')) as {
    port: number;
    queue: {
        enabled: boolean;
        rabbitmq: string;
        queue: string;
    };
    redis: string;
};

const redis = new Redis(config.redis);

const client = axios.create({
    validateStatus: () => true
});

let rabbitMq: amqp.Channel;

async function run() {
    try {
        rabbitMq = await setup(config.queue.rabbitmq, config.queue.queue);

        beforeShutdown(async () => {
            await rabbitMq.close();
        });

        log('RabbitMQ set up.');
    } catch (e) {
        error('RabbitMQ init error:', e);
        process.exit(-1);
    }

    log('Consuming.');
    await rabbitMq.consume(
        config.queue.queue,
        async msg => {
            const data = JSON.parse(msg.content.toString());

            // since the actual proxy sets this key, this is a more reliable way of checking the ratelimit
            if (await redis.exists(`webhookRatelimit:${data.id}`)) {
                // mark message as dead, will be requeued via DLX
                return rabbitMq.reject(msg);
            }

            let response: AxiosResponse<any>;

            try {
                response = await client.post(
                    `http://localhost:${config.port}/api/webhooks/${data.id}/${data.token}?wait=false${
                        data.threadId ? '&thread_id=' + data.threadId : ''
                    }`,
                    data.body,
                    {
                        headers: {
                            'User-Agent':
                                'WebhookProxy-QueueProcessor/1.0 (https://github.com/LewisTehMinerz/webhook-proxy)',
                            'Content-Type': 'application/json'
                        }
                    }
                );
            } catch (e) {
                error('Failed to submit webhook to self:', e);
                return rabbitMq.reject(msg);
            }

            // can be ratelimited due to concurrency (e.g., sending webhooks manually + queueing)
            if (response.status === 429) return rabbitMq.reject(msg); // die if ratelimited

            if (response.status >= 400 && response.status < 500) {
                warn(data.id, 'made a bad request');
            }

            rabbitMq.ack(msg);
        },
        { noAck: false }
    );
}

run();
