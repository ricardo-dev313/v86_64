#!/usr/bin/env node
// A state image saved in long mode restores the registers that only exist with their full
// width there: star/lstar/cstar/sfmask, the fs/gs/kernel gs bases, cr2, the idtr and gdtr bases
// and the pending lazy flags of a 64-bit operation (see state.asm).
// Same knobs as run.js: DISABLE_JIT, V86_WASM_PATH, TEST_RELEASE_BUILD.

import url from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const asm_file = path.join(__dirname, "state.asm");
const bin_file = path.join(__dirname, "state.bin");

try {
    execFileSync("nasm", ["-w+error", "-f", "bin", "-o", bin_file, asm_file]);
} catch(e) {
    console.log("nasm not available or failed, test skipped");
    process.exit(0);
}

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const RESULTS = 0x90000;
const BEFORE = 0x90100;
const FLAG = 0x9000;

const expected = [
    [0x845n, "flags (CF, PF, ZF, OF)"],
    [0x0023001000000000n, "star"],
    [0xFFFFFFFF81000080n, "lstar"],
    [0xFFFFFFFF81001640n, "cstar"],
    [0x0000000000257FD5n, "sfmask"],
    [0x00007F1234567000n, "fs base"],
    [0xFFFF888012345000n, "gs base"],
    [0x00007F7654321000n, "kernel gs base"],
    [0xFFFF800012345678n, "cr2"],
    [0xFFFFFE0000000000n, "idtr base"],
    [0xFFFFFE0000001000n, "gdtr base"],
    [0x1122334455667788n, "r12"],
];

const config = {
    bios: { url: bin_file },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
    wasm_path: process.env.V86_WASM_PATH,
};

function read_qwords(emulator, address)
{
    const data = emulator.read_memory(address, expected.length * 8);
    return new BigUint64Array(data.slice().buffer, 0, expected.length);
}

function wait_for_byte(emulator, byte)
{
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for '" + String.fromCharCode(byte) + "'")), 60 * 1000);
        emulator.add_listener("serial0-output-byte", b => {
            if(b === byte)
            {
                clearTimeout(timeout);
                resolve();
            }
        });
    });
}

const first = new V86(config);
await wait_for_byte(first, 0x41); // 'A'
const before = read_qwords(first, BEFORE);
const state = await first.save_state();
await first.destroy();

const second = new V86({ ...config, initial_state: { buffer: state } });
const finished = wait_for_byte(second, 0x4B); // 'K'
await new Promise(resolve => second.add_listener("emulator-started", resolve));
second.write_memory(new Uint8Array([1]), FLAG);
await finished;
const after = read_qwords(second, RESULTS);
await second.destroy();

let failed = false;
for(let i = 0; i < expected.length; i++)
{
    // the flags are only read after the restore
    if(i > 0 && before[i] !== expected[i][0])
    {
        console.log(`[-] ${expected[i][1]} before saving: expected 0x${expected[i][0].toString(16)}, got 0x${before[i].toString(16)}`);
        failed = true;
    }
    if(after[i] !== expected[i][0])
    {
        console.log(`[-] ${expected[i][1]} after restoring: expected 0x${expected[i][0].toString(16)}, got 0x${after[i].toString(16)}`);
        failed = true;
    }
}
if(failed)
{
    process.exit(1);
}
console.log("[+] longmode state test passed");
