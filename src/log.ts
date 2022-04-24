// basic logger with timestamps
const white = '\u001b[30;47m';
const yellow = '\u001b[37;43m';
const red = '\u001b[37;41m';

export function log(...args: any[]) {
    console.log(white, new Date().toISOString(), '\u001b[0m', white, 'i', '\u001b[0m', ...args);
}

export function warn(...args: any[]) {
    console.warn(yellow, new Date().toISOString(), '\u001b[0m', yellow, '!', '\u001b[0m', ...args);
}

export function error(...args: any[]) {
    console.error(red, new Date().toISOString(), '\u001b[0m', red, '!!', '\u001b[0m', ...args);
}
