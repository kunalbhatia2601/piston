const express = require('express');
const router = express.Router();

const events = require('events');

const runtime = require('../runtime');
const { Job } = require('../job');
const package = require('../package');
const globals = require('../globals');
const logger = require('logplease').create('api/v2');

function get_job(body) {
    let {
        language,
        version,
        args,
        stdin,
        files,
        compile_memory_limit,
        run_memory_limit,
        run_timeout,
        compile_timeout,
        run_cpu_time,
        compile_cpu_time,
    } = body;

    return new Promise((resolve, reject) => {
        if (!language || typeof language !== 'string') {
            return reject({
                message: 'language is required as a string',
            });
        }
        if (!version || typeof version !== 'string') {
            return reject({
                message: 'version is required as a string',
            });
        }
        if (!files || !Array.isArray(files)) {
            return reject({
                message: 'files is required as an array',
            });
        }
        for (const [i, file] of files.entries()) {
            if (typeof file.content !== 'string') {
                return reject({
                    message: `files[${i}].content is required as a string`,
                });
            }
        }

        const rt = runtime.get_latest_runtime_matching_language_version(
            language,
            version
        );
        if (rt === undefined) {
            return reject({
                message: `${language}-${version} runtime is unknown`,
            });
        }

        if (
            rt.language !== 'file' &&
            !files.some(file => !file.encoding || file.encoding === 'utf8')
        ) {
            return reject({
                message: 'files must include at least one utf8 encoded file',
            });
        }

        for (const constraint of ['memory_limit', 'timeout', 'cpu_time']) {
            for (const type of ['compile', 'run']) {
                const constraint_name = `${type}_${constraint}`;
                const constraint_value = body[constraint_name];
                const configured_limit = rt[`${constraint}s`][type];
                if (!constraint_value) {
                    continue;
                }
                if (typeof constraint_value !== 'number') {
                    return reject({
                        message: `If specified, ${constraint_name} must be a number`,
                    });
                }
                if (configured_limit <= 0) {
                    continue;
                }
                if (constraint_value > configured_limit) {
                    return reject({
                        message: `${constraint_name} cannot exceed the configured limit of ${configured_limit}`,
                    });
                }
                if (constraint_value < 0) {
                    return reject({
                        message: `${constraint_name} must be non-negative`,
                    });
                }
            }
        }

        resolve(
            new Job({
                runtime: rt,
                args: args ?? [],
                stdin: stdin ?? '',
                files,
                timeouts: {
                    run: run_timeout ?? rt.timeouts.run,
                    compile: compile_timeout ?? rt.timeouts.compile,
                },
                cpu_times: {
                    run: run_cpu_time ?? rt.cpu_times.run,
                    compile: compile_cpu_time ?? rt.cpu_times.compile,
                },
                memory_limits: {
                    run: run_memory_limit ?? rt.memory_limits.run,
                    compile: compile_memory_limit ?? rt.memory_limits.compile,
                },
            })
        );
    });
}

router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    if (!req.headers['content-type']?.startsWith('application/json')) {
        return res.status(415).send({
            message: 'requests must be of type application/json',
        });
    }

    next();
});

router.ws('/connect', async (ws, req) => {
    let job = null;
    let event_bus = new events.EventEmitter();

    event_bus.on('stdout', data =>
        ws.send(
            JSON.stringify({
                type: 'data',
                stream: 'stdout',
                data: data.toString(),
            })
        )
    );
    event_bus.on('stderr', data =>
        ws.send(
            JSON.stringify({
                type: 'data',
                stream: 'stderr',
                data: data.toString(),
            })
        )
    );
    event_bus.on('stage', stage =>
        ws.send(JSON.stringify({ type: 'stage', stage }))
    );
    event_bus.on('exit', (stage, status) =>
        ws.send(JSON.stringify({ type: 'exit', stage, ...status }))
    );

    ws.on('message', async data => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'init':
                    if (job === null) {
                        job = await get_job(msg);

                        try {
                            const box = await job.prime();

                            ws.send(
                                JSON.stringify({
                                    type: 'runtime',
                                    language: job.runtime.language,
                                    version: job.runtime.version.raw,
                                })
                            );

                            await job.execute(box, event_bus);
                        } catch (error) {
                            logger.error(
                                `Error cleaning up job: ${job.uuid}:\n${error}`
                            );
                            throw error;
                        } finally {
                            await job.cleanup();
                        }
                        ws.close(4999, 'Job Completed'); // Will not execute if an error is thrown above
                    } else {
                        ws.close(4000, 'Already Initialized');
                    }
                    break;
                case 'data':
                    if (job !== null) {
                        if (msg.stream === 'stdin') {
                            event_bus.emit('stdin', msg.data);
                        } else {
                            ws.close(4004, 'Can only write to stdin');
                        }
                    } else {
                        ws.close(4003, 'Not yet initialized');
                    }
                    break;
                case 'signal':
                    if (job !== null) {
                        if (
                            Object.values(globals.SIGNALS).includes(msg.signal)
                        ) {
                            event_bus.emit('signal', msg.signal);
                        } else {
                            ws.close(4005, 'Invalid signal');
                        }
                    } else {
                        ws.close(4003, 'Not yet initialized');
                    }
                    break;
            }
        } catch (error) {
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
            ws.close(4002, 'Notified Error');
            // ws.close message is limited to 123 characters, so we notify over WS then close.
        }
    });

    setTimeout(() => {
        //Terminate the socket after 1 second, if not initialized.
        if (job === null) ws.close(4001, 'Initialization Timeout');
    }, 1000);
});

/**
 * Multi-test WebSocket endpoint
 * Supports: init -> compile once -> run_test (multiple) -> close
 */
router.ws('/judge', async (ws, req) => {
    let job = null;
    let box = null;
    let testCount = 0;
    let totalTime = 0;
    let isCompiled = false;

    const sendMessage = (type, data) => {
        ws.send(JSON.stringify({ type, ...data }));
    };

    ws.on('message', async data => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'init':
                    if (job !== null) {
                        ws.close(4000, 'Already Initialized');
                        return;
                    }

                    // Validate and create job
                    try {
                        job = await get_job(msg);
                    } catch (error) {
                        sendMessage('error', { message: error.message });
                        ws.close(4002, 'Notified Error');
                        return;
                    }

                    try {
                        // Prime the job (create sandbox, copy files)
                        box = await job.prime();

                        // Send ready message
                        sendMessage('ready', {
                            language: job.runtime.language,
                            version: job.runtime.version.raw,
                            compiled: job.runtime.compiled
                        });

                        // Compile if needed
                        const compileResult = await job.compileOnly(box);
                        isCompiled = compileResult.success;

                        sendMessage('compiled', {
                            success: compileResult.success,
                            time: compileResult.compile?.wall_time || 0,
                            stdout: compileResult.compile?.stdout || '',
                            stderr: compileResult.compile?.stderr || '',
                            error: compileResult.compile?.message || null
                        });

                        if (!isCompiled) {
                            await job.cleanup();
                            ws.close(4006, 'Compilation Failed');
                        }
                    } catch (error) {
                        logger.error(`Error initializing job: ${job?.uuid}:\n${error}`);
                        sendMessage('error', { message: error.message });
                        if (job) await job.cleanup();
                        ws.close(4002, 'Notified Error');
                    }
                    break;

                case 'run_test':
                    if (job === null) {
                        ws.close(4003, 'Not yet initialized');
                        return;
                    }

                    if (!isCompiled) {
                        sendMessage('error', { message: 'Code did not compile successfully' });
                        return;
                    }

                    try {
                        const testResult = await job.runTest(
                            msg.stdin || '',
                            msg.timeout || null,
                            msg.cpu_time || null,
                            msg.memory_limit || null
                        );

                        testCount++;
                        totalTime += testResult.wall_time || 0;

                        sendMessage('result', {
                            test_id: msg.test_id || testCount,
                            stdout: testResult.stdout,
                            stderr: testResult.stderr,
                            code: testResult.code,
                            signal: testResult.signal,
                            message: testResult.message,
                            status: testResult.status,
                            time: testResult.wall_time,
                            cpu_time: testResult.cpu_time,
                            memory: testResult.memory
                        });
                    } catch (error) {
                        logger.error(`Error running test: ${error.message}`);
                        sendMessage('error', {
                            test_id: msg.test_id || testCount + 1,
                            message: error.message
                        });
                    }
                    break;

                case 'run_batch':
                    if (job === null) {
                        ws.close(4003, 'Not yet initialized');
                        return;
                    }

                    if (!isCompiled) {
                        sendMessage('error', { message: 'Code did not compile successfully' });
                        return;
                    }

                    if (!msg.test_cases || !Array.isArray(msg.test_cases) || msg.test_cases.length === 0) {
                        sendMessage('error', { message: 'test_cases array is required for run_batch' });
                        return;
                    }

                    try {
                        const batchResult = await job.runBatched(
                            msg.test_cases,
                            msg.timeout || null,
                            msg.cpu_time || null,
                            msg.memory_limit || null
                        );

                        testCount = msg.test_cases.length;
                        totalTime = batchResult.total_time || 0;

                        sendMessage('batch_result', {
                            results: batchResult.results,
                            total_tests: testCount,
                            total_time: batchResult.total_time,
                            total_cpu_time: batchResult.total_cpu_time,
                            memory: batchResult.memory,
                            success: batchResult.success,
                            stderr: batchResult.stderr
                        });
                    } catch (error) {
                        logger.error(`Error running batch: ${error.message}`);
                        sendMessage('error', { message: error.message });
                    }
                    break;

                case 'close':
                    sendMessage('done', {
                        total_tests: testCount,
                        total_time: totalTime
                    });
                    if (job) await job.cleanup();
                    ws.close(4999, 'Session Completed');
                    break;

                default:
                    sendMessage('error', { message: `Unknown message type: ${msg.type}` });
            }
        } catch (error) {
            sendMessage('error', { message: error.message });
            ws.close(4002, 'Notified Error');
        }
    });

    ws.on('close', async () => {
        if (job) {
            try {
                await job.cleanup();
            } catch (e) {
                logger.error(`Error cleaning up job on close: ${e.message}`);
            }
        }
    });

    // Timeout if not initialized within 5 seconds
    setTimeout(() => {
        if (job === null) ws.close(4001, 'Initialization Timeout');
    }, 5000);
});

router.post('/execute', async (req, res) => {
    let job;
    try {
        job = await get_job(req.body);
    } catch (error) {
        return res.status(400).json(error);
    }
    try {
        const box = await job.prime();

        let result = await job.execute(box);
        // Backward compatibility when the run stage is not started
        if (result.run === undefined) {
            result.run = result.compile;
        }

        return res.status(200).send(result);
    } catch (error) {
        logger.error(`Error executing job: ${job.uuid}:\n${error}`);
        return res.status(500).send();
    } finally {
        try {
            await job.cleanup(); // This gets executed before the returns in try/catch
        } catch (error) {
            logger.error(`Error cleaning up job: ${job.uuid}:\n${error}`);
            return res.status(500).send(); // On error, this replaces the return in the outer try-catch
        }
    }
});

router.get('/runtimes', (req, res) => {
    const runtimes = runtime.map(rt => {
        return {
            language: rt.language,
            version: rt.version.raw,
            aliases: rt.aliases,
            runtime: rt.runtime,
        };
    });

    return res.status(200).send(runtimes);
});

router.get('/packages', async (req, res) => {
    logger.debug('Request to list packages');
    let packages = await package.get_package_list();

    packages = packages.map(pkg => {
        return {
            language: pkg.language,
            language_version: pkg.version.raw,
            installed: pkg.installed,
        };
    });

    return res.status(200).send(packages);
});

router.post('/packages', async (req, res) => {
    logger.debug('Request to install package');

    const { language, version } = req.body;

    const pkg = await package.get_package(language, version);

    if (pkg == null) {
        return res.status(404).send({
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        const response = await pkg.install();

        return res.status(200).send(response);
    } catch (e) {
        logger.error(
            `Error while installing package ${pkg.language}-${pkg.version}:`,
            e.message
        );

        return res.status(500).send({
            message: e.message,
        });
    }
});

router.delete('/packages', async (req, res) => {
    logger.debug('Request to uninstall package');

    const { language, version } = req.body;

    const pkg = await package.get_package(language, version);

    if (pkg == null) {
        return res.status(404).send({
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        const response = await pkg.uninstall();

        return res.status(200).send(response);
    } catch (e) {
        logger.error(
            `Error while uninstalling package ${pkg.language}-${pkg.version}:`,
            e.message
        );

        return res.status(500).send({
            message: e.message,
        });
    }
});

module.exports = router;
