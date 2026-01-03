/**
 * Piston API Benchmark Test
 * Compares /execute API vs /judge WebSocket performance
 * 
 * Usage: node benchmark.js
 */

const WebSocket = require('ws');
const axios = require('axios');

// ============================================
// CONFIGURATION
// ============================================
const config = {
    baseUrl: 'https://exec1.academy-os.in',  // Change to your VPS URL
    wsUrl: 'wss://exec1.academy-os.in',       // WebSocket URL

    language: 'python',
    version: '*',

    code: `
n = int(input())
print(n * 2)
`,

    testCases: [
        { input: '1\n', expected: '2' },
        { input: '2\n', expected: '4' },
        { input: '3\n', expected: '6' },
        { input: '4\n', expected: '8' },
        { input: '5\n', expected: '10' },
        { input: '10\n', expected: '20' },
        { input: '15\n', expected: '30' },
        { input: '20\n', expected: '40' },
        { input: '25\n', expected: '50' },
        { input: '50\n', expected: '100' },
        { input: '100\n', expected: '200' },
        { input: '200\n', expected: '400' },
        { input: '500\n', expected: '1000' },
        { input: '1000\n', expected: '2000' },
        { input: '999\n', expected: '1998' },
        { input: '123\n', expected: '246' },
        { input: '456\n', expected: '912' },
        { input: '789\n', expected: '1578' },
        { input: '42\n', expected: '84' },
        { input: '7\n', expected: '14' },
    ]
};

// ============================================
// BENCHMARK: /execute API (Multiple Calls)
// ============================================
async function benchmarkExecuteAPI() {
    console.log('\n📊 Benchmarking /execute API...');
    console.log(`   Running ${config.testCases.length} separate API calls\n`);

    const startTime = Date.now();
    const results = [];

    for (let i = 0; i < config.testCases.length; i++) {
        const tc = config.testCases[i];
        const testStart = Date.now();

        try {
            const response = await axios.post(`${config.baseUrl}/api/v2/execute`, {
                language: config.language,
                version: config.version,
                files: [{ content: config.code }],
                stdin: tc.input
            });

            const testTime = Date.now() - testStart;
            const actual = response.data.run?.stdout?.trim();
            const passed = actual === tc.expected;

            results.push({
                testId: i + 1,
                passed,
                expected: tc.expected,
                actual,
                time: testTime
            });

            console.log(`   Test ${i + 1}: ${passed ? '✅' : '❌'} | ${testTime}ms`);
        } catch (error) {
            results.push({
                testId: i + 1,
                passed: false,
                error: error.message
            });
            console.log(`   Test ${i + 1}: ❌ Error: ${error.message}`);
        }
    }

    const totalTime = Date.now() - startTime;
    const passedCount = results.filter(r => r.passed).length;

    console.log(`\n   Results: ${passedCount}/${results.length} passed`);
    console.log(`   ⏱️  Total time: ${totalTime}ms`);

    return { api: 'execute', totalTime, results, passedCount };
}

// ============================================
// BENCHMARK: /judge WebSocket API
// ============================================
async function benchmarkJudgeAPI() {
    return new Promise((resolve, reject) => {
        console.log('\n📊 Benchmarking /judge WebSocket API...');
        console.log(`   Running ${config.testCases.length} tests via WebSocket\n`);

        const startTime = Date.now();
        const results = [];
        let currentTest = 0;
        let compileTime = 0;

        const ws = new WebSocket(`${config.wsUrl}/api/v2/judge`);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'init',
                language: config.language,
                version: config.version,
                files: [{ content: config.code }]
            }));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data);

            if (msg.type === 'compiled') {
                compileTime = msg.time || 0;
                if (msg.success) {
                    console.log(`   Compiled in ${compileTime}ms`);
                    sendNextTest();
                } else {
                    console.log(`   ❌ Compilation failed: ${msg.stderr}`);
                    ws.close();
                    resolve({ api: 'judge', error: 'Compilation failed', totalTime: Date.now() - startTime });
                }
            }

            if (msg.type === 'result') {
                const tc = config.testCases[currentTest];
                const actual = msg.stdout?.trim();
                const passed = actual === tc.expected;

                results.push({
                    testId: msg.test_id,
                    passed,
                    expected: tc.expected,
                    actual,
                    time: msg.time
                });

                console.log(`   Test ${msg.test_id}: ${passed ? '✅' : '❌'} | ${msg.time}ms`);

                currentTest++;
                if (currentTest < config.testCases.length) {
                    sendNextTest();
                } else {
                    ws.send(JSON.stringify({ type: 'close' }));
                }
            }

            if (msg.type === 'done') {
                const totalTime = Date.now() - startTime;
                const passedCount = results.filter(r => r.passed).length;

                console.log(`\n   Results: ${passedCount}/${results.length} passed`);
                console.log(`   ⏱️  Total time: ${totalTime}ms (compile: ${compileTime}ms)`);

                ws.close();
                resolve({ api: 'judge', totalTime, results, passedCount, compileTime });
            }

            if (msg.type === 'error') {
                console.log(`   ❌ Error: ${msg.message}`);
            }
        });

        function sendNextTest() {
            const tc = config.testCases[currentTest];
            ws.send(JSON.stringify({
                type: 'run_test',
                stdin: tc.input,
                test_id: currentTest + 1
            }));
        }

        ws.on('error', (err) => {
            reject(err);
        });

        ws.on('close', () => {
            // Already resolved above
        });

        // Timeout after 60 seconds
        setTimeout(() => {
            ws.close();
            reject(new Error('Timeout'));
        }, 60000);
    });
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('═'.repeat(50));
    console.log('  PISTON API BENCHMARK');
    console.log('═'.repeat(50));
    console.log(`\n📋 Config:`);
    console.log(`   Base URL: ${config.baseUrl}`);
    console.log(`   Language: ${config.language}`);
    console.log(`   Test Cases: ${config.testCases.length}`);

    try {
        // Run /execute benchmark
        const executeResult = await benchmarkExecuteAPI();

        // Small delay between tests
        await new Promise(r => setTimeout(r, 2000));

        // Run /judge benchmark (individual tests)
        const judgeResult = await benchmarkJudgeAPI();

        // Small delay
        await new Promise(r => setTimeout(r, 2000));

        // Run /judge batch benchmark (single process)
        const batchResult = await benchmarkBatchAPI();

        // Summary
        console.log('\n' + '═'.repeat(50));
        console.log('  COMPARISON');
        console.log('═'.repeat(50));
        console.log(`\n   /execute API:    ${executeResult.totalTime}ms`);
        console.log(`   /judge (each):   ${judgeResult.totalTime}ms`);
        console.log(`   /judge (batch):  ${batchResult.totalTime}ms`);

        const fastest = Math.min(executeResult.totalTime, judgeResult.totalTime, batchResult.totalTime);
        let winner = '/execute';
        if (fastest === judgeResult.totalTime) winner = '/judge (each)';
        if (fastest === batchResult.totalTime) winner = '/judge (batch)';

        console.log(`\n   🏆 ${winner} is fastest!`);
        console.log('═'.repeat(50));

    } catch (error) {
        console.error('Error:', error.message);
    }
}

// ============================================
// BENCHMARK: /judge WebSocket API (BATCH MODE)
// ============================================
async function benchmarkBatchAPI() {
    return new Promise((resolve, reject) => {
        console.log('\n📊 Benchmarking /judge WebSocket API (BATCH MODE)...');
        console.log(`   Running ${config.testCases.length} tests in SINGLE process\n`);

        const startTime = Date.now();
        let compileTime = 0;

        const ws = new WebSocket(`${config.wsUrl}/api/v2/judge`);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'init',
                language: config.language,
                version: config.version,
                files: [{ content: config.code }]
            }));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data);

            if (msg.type === 'compiled') {
                compileTime = msg.time || 0;
                if (msg.success) {
                    console.log(`   Compiled in ${compileTime}ms`);
                    // Send ALL tests at once with run_batch
                    ws.send(JSON.stringify({
                        type: 'run_batch',
                        test_cases: config.testCases.map((tc, i) => ({
                            stdin: tc.input,
                            test_id: i + 1
                        }))
                    }));
                } else {
                    console.log(`   ❌ Compilation failed: ${msg.stderr}`);
                    ws.close();
                    resolve({ api: 'batch', error: 'Compilation failed', totalTime: Date.now() - startTime });
                }
            }

            if (msg.type === 'batch_result') {
                const results = msg.results || [];
                let passedCount = 0;

                results.forEach((r, i) => {
                    const tc = config.testCases[i];
                    const passed = r.stdout === tc.expected;
                    if (passed) passedCount++;
                    console.log(`   Test ${r.test_id}: ${passed ? '✅' : '❌'} | output: ${r.stdout}`);
                });

                const totalTime = Date.now() - startTime;
                console.log(`\n   Results: ${passedCount}/${results.length} passed`);
                console.log(`   ⏱️  Total time: ${totalTime}ms (server: ${msg.total_time}ms)`);

                ws.send(JSON.stringify({ type: 'close' }));
                ws.close();
                resolve({ api: 'batch', totalTime, results, passedCount, serverTime: msg.total_time });
            }

            if (msg.type === 'error') {
                console.log(`   ❌ Error: ${msg.message}`);
                ws.close();
                resolve({ api: 'batch', error: msg.message, totalTime: Date.now() - startTime });
            }
        });

        ws.on('error', (err) => {
            reject(err);
        });

        // Timeout after 120 seconds (batch can take longer)
        setTimeout(() => {
            ws.close();
            reject(new Error('Timeout'));
        }, 120000);
    });
}

main();

