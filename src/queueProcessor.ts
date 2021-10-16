import amqp from 'amqplib';
import axios from 'axios';

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
};

const client = axios.create({
    validateStatus: () => true
});

let rabbitMq: amqp.Channel;

// [webhook id]: reset time
const ratelimits: { [id: string]: number } = {};

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
    while (true) {
        await rabbitMq.consume(
            config.queue.queue,
            async msg => {
                const data = JSON.parse(msg.content.toString());

                const ratelimit = ratelimits[data.id];
                if (ratelimit) {
                    if (ratelimit < Date.now() / 1000) {
                        delete ratelimits[data.id];
                    } else {
                        // mark message as dead, will be requeued via DLX
                        return rabbitMq.reject(msg);
                    }
                }

                const response = await client.post(
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
}

run();
