/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { KEM_C, Pointer } from './types/kem_c_binding';
import createWASMKEMNativeCaller from './kem.wasm.js';
import createJSKEMNativeCaller from './kem.asm.js';

// https://github.com/emscripten-core/emscripten/issues/11792#issuecomment-877120580
/* nodeblock:start */
import { dirname } from 'path';
import { createRequire } from 'module';
globalThis.__dirname = dirname(import.meta.url);
globalThis.require = createRequire(import.meta.url);
/* nodeblock:end */
// eslint-disable-next-line no-empty
{
} // So the comment above is not dropped during transpilation

export interface KEM {
    publicKeyBytes: number;
    privateKeyBytes: number;
    ciphertextBytes: number;
    sharedSecretBytes: number;

    keypair: () => Promise<{
        publicKey: Uint8Array;
        privateKey: Uint8Array;
    }>;
    encapsulate: (publicKey: Uint8Array) => Promise<{
        ciphertext: Uint8Array;
        sharedSecret: Uint8Array;
    }>;
    decapsulate: (
        ciphertext: Uint8Array,
        privateKey: Uint8Array
    ) => Promise<{
        sharedSecret: Uint8Array;
    }>;
}

async function kemBuilder(useFallback = false, wasmFilePath: string | undefined = undefined): Promise<KEM> {
    let Module = {} as KEM_C;

    if (wasmFilePath) {
        Module.locateFile = () => {
            return wasmFilePath;
        };
    }

    if (useFallback) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        Module = (await createJSKEMNativeCaller(Module)) as unknown as KEM_C;
    } else {
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            Module = (await createWASMKEMNativeCaller(Module)) as unknown as KEM_C;
        } catch (err) {
            console.error('Failed to initialize KEM WASM, using fallback instead', err);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            Module = (await createJSKEMNativeCaller(Module)) as unknown as KEM_C;
        }
    }

    // This block is only needed when running on Node.js to avoid usage of `require` in libsodium
    // cf https://github.com/jedisct1/libsodium/issues/1180
    /* nodeblock:start */
    {
        const crypto = await import('crypto');
        const randomValueNodeJS = () => {
            const buf = crypto.randomBytes(4);
            return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
        };
        randomValueNodeJS();
        Module.getRandomValue = randomValueNodeJS;

        const { subtle } = crypto.webcrypto;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        Module.subtleCrypto = subtle as any;
    }
    /* nodeblock:end */

    if (!Module.subtleCrypto) {
        Module.subtleCrypto = self.crypto.subtle;
    }

    function dataReturn<T>(returnValue: number, result: T): T {
        if (returnValue === 0) {
            return result;
        } else {
            throw new Error(`KEM error: ${returnValue}`);
        }
    }

    function dataResult(buffer: Pointer, size: number): Uint8Array {
        return new Uint8Array(new Uint8Array(Module.HEAPU8.buffer, buffer, size));
    }

    function dataFree(buffer: Pointer) {
        try {
            Module._free(buffer);
        } catch (err) {
            setTimeout(() => {
                throw err;
            }, 0);
        }
    }

    Module._kem_init();

    const publicKeyBytes = Module._kem_public_key_bytes();
    const privateKeyBytes = Module._kem_private_key_bytes();
    const ciphertextBytes = Module._kem_ciphertext_bytes();
    const sharedSecretBytes = Module._kem_shared_secret_bytes();

    return {
        publicKeyBytes,
        privateKeyBytes,
        ciphertextBytes,
        sharedSecretBytes,

        keypair: async () => {
            const release = await bindingCallerMutex.lock();

            const publicKeyBuffer = Module._malloc(publicKeyBytes);
            const privateKeyBuffer = Module._malloc(privateKeyBytes);

            try {
                const returnValue: number = await Module.ccall(
                    'kem_keypair',
                    'number',
                    ['number', 'number'],
                    [publicKeyBuffer, privateKeyBuffer],
                    { async: true }
                );
                return dataReturn(returnValue, {
                    publicKey: dataResult(publicKeyBuffer, publicKeyBytes),
                    privateKey: dataResult(privateKeyBuffer, privateKeyBytes),
                });
            } finally {
                release();
                dataFree(publicKeyBuffer);
                dataFree(privateKeyBuffer);
            }
        },

        encapsulate: async (publicKey) => {
            const release = await bindingCallerMutex.lock();

            const ciphertextBuffer = Module._malloc(ciphertextBytes);
            const sharedSecretBuffer = Module._malloc(sharedSecretBytes);
            const publicKeyBuffer = Module._malloc(publicKeyBytes);

            Module.writeArrayToMemory(publicKey, publicKeyBuffer);

            try {
                const returnValue: number = await Module.ccall(
                    'kem_encapsulate',
                    'number',
                    ['number', 'number', 'number'],
                    [ciphertextBuffer, sharedSecretBuffer, publicKeyBuffer],
                    { async: true }
                );
                return dataReturn(returnValue, {
                    ciphertext: dataResult(ciphertextBuffer, ciphertextBytes),
                    sharedSecret: dataResult(sharedSecretBuffer, sharedSecretBytes),
                });
            } finally {
                release();
                dataFree(ciphertextBuffer);
                dataFree(sharedSecretBuffer);
                dataFree(publicKeyBuffer);
            }
        },

        decapsulate: async (ciphertext, privateKey) => {
            const release = await bindingCallerMutex.lock();

            const sharedSecretBuffer = Module._malloc(sharedSecretBytes);
            const ciphertextBuffer = Module._malloc(ciphertextBytes);
            const privateKeyBuffer = Module._malloc(privateKeyBytes);

            Module.writeArrayToMemory(ciphertext, ciphertextBuffer);
            Module.writeArrayToMemory(privateKey, privateKeyBuffer);

            try {
                const returnValue: number = await Module.ccall(
                    'kem_decapsulate',
                    'number',
                    ['number', 'number', 'number'],
                    [sharedSecretBuffer, ciphertextBuffer, privateKeyBuffer],
                    { async: true }
                );
                return dataReturn(returnValue, {
                    sharedSecret: dataResult(sharedSecretBuffer, sharedSecretBytes),
                });
            } finally {
                release();
                dataFree(sharedSecretBuffer);
                dataFree(ciphertextBuffer);
                dataFree(privateKeyBuffer);
            }
        },
    };
}

// Taken from https://stackoverflow.com/questions/51086688/mutex-in-javascript-does-this-look-like-a-correct-implementation
class Mutex {
    current: Promise<void>;

    constructor() {
        this.current = Promise.resolve();
    }

    lock() {
        let _resolve: () => void;
        const p = new Promise<void>((resolve) => {
            _resolve = () => resolve();
        });
        const rv = this.current.then(() => _resolve);
        this.current = p;
        return rv;
    }
}

// Only one call to the library can fly at once, the mutex below restricts the number of concurrent calls
const bindingCallerMutex = new Mutex();

export default kemBuilder;
