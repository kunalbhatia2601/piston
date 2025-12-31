# Piston Judge API Documentation

## Endpoint

```
WebSocket: ws://YOUR_VPS_IP:8867/api/v2/judge
```

## Purpose

Compile-once, run-many test case execution. Optimized for:
- Competitive programming judges
- LeetCode-style problem evaluation
- Exam/assessment systems

---

## Message Protocol

### Client → Server

| Message Type | Description |
|--------------|-------------|
| `init` | Initialize with code and language |
| `run_test` | Execute a single test case |
| `close` | End session and cleanup |

### Server → Client

| Message Type | Description |
|--------------|-------------|
| `ready` | Runtime info after connection |
| `compiled` | Compilation result |
| `result` | Test case execution result |
| `error` | Error message |
| `done` | Session summary |

---

## Message Schemas

### 1. init (Client → Server)

```json
{
    "type": "init",
    "language": "python",
    "version": "*",
    "files": [
        { "name": "main.py", "content": "print(int(input()) * 2)" }
    ]
}
```

### 2. ready (Server → Client)

```json
{
    "type": "ready",
    "language": "python",
    "version": "3.10.0",
    "compiled": false
}
```

### 3. compiled (Server → Client)

```json
{
    "type": "compiled",
    "success": true,
    "time": 1234,
    "stdout": "",
    "stderr": "",
    "error": null
}
```

### 4. run_test (Client → Server)

```json
{
    "type": "run_test",
    "stdin": "5\n",
    "test_id": 1,
    "timeout": 5000,
    "memory_limit": 268435456
}
```

### 5. result (Server → Client)

```json
{
    "type": "result",
    "test_id": 1,
    "stdout": "10\n",
    "stderr": "",
    "code": 0,
    "signal": null,
    "message": null,
    "status": null,
    "time": 45,
    "cpu_time": 12,
    "memory": 8192
}
```

### 6. close (Client → Server)

```json
{ "type": "close" }
```

### 7. done (Server → Client)

```json
{
    "type": "done",
    "total_tests": 5,
    "total_time": 230
}
```

---

## Flow Diagram

```
Client                              Server
  │                                    │
  ├── WebSocket Connect ───────────────►
  │                                    │
  ├── init ────────────────────────────►
  │                                    │
  │◄────────────────────────────── ready
  │◄───────────────────────────compiled
  │                                    │
  ├── run_test (test 1) ───────────────►
  │◄──────────────────────────── result
  │                                    │
  ├── run_test (test 2) ───────────────►
  │◄──────────────────────────── result
  │                                    │
  ├── close ───────────────────────────►
  │◄───────────────────────────── done
  │                                    │
  X── Connection Closed ───────────────X
```

---

## AcademyOS Integration Example

### Backend Service (Node.js)

```javascript
// services/pistonJudge.js
const WebSocket = require('ws');

class PistonJudge {
    constructor(pistonUrl = 'ws://YOUR_VPS:8867/api/v2/judge') {
        this.pistonUrl = pistonUrl;
    }

    async judge(code, language, testCases) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.pistonUrl);
            const results = [];
            let currentTest = 0;

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'init',
                    language,
                    version: '*',
                    files: [{ content: code }]
                }));
            });

            ws.on('message', (data) => {
                const msg = JSON.parse(data);

                if (msg.type === 'compiled' && msg.success) {
                    sendTest();
                } else if (msg.type === 'compiled' && !msg.success) {
                    resolve({ 
                        success: false, 
                        error: 'compilation', 
                        message: msg.stderr 
                    });
                    ws.close();
                }

                if (msg.type === 'result') {
                    results.push({
                        testId: msg.test_id,
                        passed: msg.stdout.trim() === testCases[currentTest].expected,
                        stdout: msg.stdout,
                        time: msg.time,
                        memory: msg.memory
                    });
                    currentTest++;
                    if (currentTest < testCases.length) {
                        sendTest();
                    } else {
                        ws.send(JSON.stringify({ type: 'close' }));
                    }
                }

                if (msg.type === 'done') {
                    resolve({
                        success: true,
                        passed: results.filter(r => r.passed).length,
                        total: results.length,
                        totalTime: msg.total_time,
                        results
                    });
                }

                if (msg.type === 'error') {
                    reject(new Error(msg.message));
                }
            });

            function sendTest() {
                ws.send(JSON.stringify({
                    type: 'run_test',
                    stdin: testCases[currentTest].input,
                    test_id: currentTest + 1
                }));
            }

            ws.on('error', reject);
            
            setTimeout(() => {
                ws.close();
                reject(new Error('Timeout'));
            }, 60000);
        });
    }
}

module.exports = new PistonJudge();
```

### API Route Usage

```javascript
// routes/submit.js
const pistonJudge = require('../services/pistonJudge');

app.post('/api/submit', async (req, res) => {
    const { code, language, problemId } = req.body;
    
    // Get test cases from database
    const problem = await Problem.findById(problemId);
    
    try {
        const result = await pistonJudge.judge(
            code, 
            language, 
            problem.testCases
        );
        
        // Save submission
        await Submission.create({
            userId: req.user.id,
            problemId,
            code,
            language,
            passed: result.passed,
            total: result.total,
            results: result.results
        });
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
```

---

## Close Codes

| Code | Meaning |
|------|---------|
| 4000 | Already Initialized |
| 4001 | Initialization Timeout |
| 4002 | Notified Error |
| 4003 | Not Yet Initialized |
| 4006 | Compilation Failed |
| 4999 | Session Completed |

---

## Server Endpoints Summary

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `/api/v2/execute` | HTTP POST | Single execution |
| `/api/v2/connect` | WebSocket | Interactive/REPL |
| `/api/v2/judge` | WebSocket | **Multi-test judging** |
