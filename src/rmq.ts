import amqp from 'amqplib';

export async function setup(host: string, queue: string) {
    const connection = await amqp.connect(host);
    const channel = await connection.createChannel();

    // setup dead letter exchange for requeues
    await channel.assertExchange(queue, 'direct', { durable: true });
    await channel.assertExchange(queue + '-dead', 'direct', { durable: true });

    await channel.assertQueue(queue, { durable: true, deadLetterExchange: queue + '-dead' });
    await channel.assertQueue(queue + '-dead', { durable: true, deadLetterExchange: queue, messageTtl: 2000 });

    await channel.bindExchange(queue, queue, '');
    await channel.bindExchange(queue + '-dead', queue + '-dead', '');

    return channel;
}
