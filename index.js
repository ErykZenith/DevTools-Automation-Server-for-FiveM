const WebSocket = require('ws');
const readline = require('readline');
const express = require('express');
const livereload = require('livereload');
const connectLiveReload = require('connect-livereload');
const chokidar = require('chokidar');
const http = require('http');
const fs = require('fs');
const path = require('path');
const currentWorkingDir = process.cwd();
const SERVER_PORT = 6900;
const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
let webSocketConnection, httpServer, networkMonitorHandler, isConnected = false, isLoggingActive = true, jsonConfig = {}
const displayCommands = () => {
    console.clear();
    console.log(` \x1b[36m:Available Commands:\x1b[0m\n \x1b[33mnet 0\x1b[0m - Stop Network Monitoring\n \x1b[33mnet 1\x1b[0m - Start Network Monitoring\n \x1b[33mnet 2\x1b[0m - Toggle Network Monitoring\n \x1b[33mdmp\x1b[0m - Dump JavaScript Files`);
};
const readConfigFile = (filePath) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return;
        try {
            jsonConfig = JSON.parse(data);
        } catch (error) {
            jsonConfig = {};
        }
    });
};
readConfigFile(path.join(currentWorkingDir, 'config.json'));
chokidar.watch(path.join(currentWorkingDir, 'config.json')).on('change', (filePath) => {
    readConfigFile(filePath);
});
const initializeServer = () => {
    if (httpServer) return;
    const app = express();
    const liveReloadServer = livereload.createServer();
    app.use(connectLiveReload());
    app.use(express.static('web'));
    liveReloadServer.watch(path.join(currentWorkingDir, 'web'));
    chokidar.watch(path.join(currentWorkingDir, 'web')).on('all', () => liveReloadServer.refresh('/'));
    httpServer = app.listen(SERVER_PORT, () => {
        webSocketConnection.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression: `
                    document.querySelectorAll("iframe").forEach(iframe => {
                        if (iframe.src === "http://localhost:${SERVER_PORT}/") iframe.remove();
                    });
                    const iframe = document.createElement("iframe");
                    iframe.src = "http://localhost:${SERVER_PORT}/";
                    document.body.appendChild(iframe);
                `
            }
        }));
        console.log('  -\x1b[36mServer initialized and content injected\x1b[0m');
    });
    httpServer.on('close', () => {
        httpServer = undefined;
        liveReloadServer.close();
    });
};
const terminateServer = () => {
    if (!httpServer) return;
    httpServer.close(() => httpServer = undefined);
};
const establishWebSocketConnection = async () => {
    if (isConnected) return console.log(' -\x1b[36mConnection already established\x1b[0m');
    try {
        const options = {
            hostname: 'localhost',
            port: 13172,
            path: '/json/list',
            method: 'GET'
        };
        const req = http.request(options, async (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', async () => {
                try {
                    const jsonData = JSON.parse(data);
                    const id = jsonData[0].id;
                    webSocketConnection = new WebSocket(`ws://localhost:13172/devtools/page/${id}`);
                    webSocketConnection.onopen = () => {
                        isConnected = true;
                        displayCommands();
                        console.log(' -\x1b[36mConnected to DevTools\x1b[0m');
                        initializeServer();
                    };
                    webSocketConnection.onclose = () => {
                        isConnected = false;
                        console.clear();
                        console.error('  -\x1b[31mDisconnected from DevTools\x1b[0m');
                        terminateServer();
                        establishWebSocketConnection();
                    };
                    webSocketConnection.onerror = () => {
                        isConnected = false;
                    };
                } catch (error) {
                    console.error("Error parsing JSON:", error);
                }
            });
        });
        req.on('error', (error) => {
            console.error("Error making HTTP request:", error);
        });
        req.end();
    } catch (error) {
        console.error("Please enter the server first.");
        setTimeout(establishWebSocketConnection, 1000);
    }
};
const dumpJavaScriptFiles = () => {
    displayCommands();
    console.log('\n -\x1b[36mDumping JavaScript files started\x1b[0m\n');
    const scriptFileIds = new Map();
    let currentRequestId = 1;
    const handleScriptContent = (scriptId, scriptContent, scriptUrl) => {
        const sanitizedFileName = scriptUrl.replace(/[<>:"/\\|?*]+/g, '_');
        const outputDirectory = path.join(currentWorkingDir, 'dumped_scripts');
        const scriptFilePath = path.join(outputDirectory, sanitizedFileName);
        fs.mkdirSync(outputDirectory, { recursive: true });
        fs.writeFileSync(scriptFilePath, scriptContent);
        console.log(`  -\x1b[32mDumped:\x1b[0m ${scriptUrl}`);
    };
    webSocketConnection.send(JSON.stringify({ id: currentRequestId++, method: 'Debugger.enable' }));
    const scriptMessageHandler = (data) => {
        const message = JSON.parse(data);
        if (message.method === 'Debugger.scriptParsed') {
            const { scriptId, url } = message.params;
            if (url && !url.startsWith('extensions::')) {
                scriptFileIds.set(currentRequestId, { scriptId, url });
                webSocketConnection.send(JSON.stringify({ id: currentRequestId++, method: 'Debugger.getScriptSource', params: { scriptId } }));
            }
        } else if (message.id && message.result?.scriptSource) {
            const { scriptId, url } = scriptFileIds.get(message.id);
            handleScriptContent(scriptId, message.result.scriptSource, url);
            if (message.id === currentRequestId - 1) {
                webSocketConnection.send(JSON.stringify({ id: currentRequestId++, method: 'Debugger.disable' }));
                webSocketConnection.off('message', scriptMessageHandler);
                displayCommands();
                console.log('\n -\x1b[36mDumping completed\x1b[0m\n');
            }
        } else if (message.method === 'Network.requestWillBeSent') {
            console.log(` Request URL: ${message.params.request.url}\n Request Method: ${message.params.request.method}`);
        } else if (message.method === 'Network.responseReceived') {
            console.log(` Status Code: ${message.params.response.status}\n Content-Type: ${message.params.response.headers['Content-Type']}`);
        }
    };
    webSocketConnection.on('message', scriptMessageHandler);
};
const initiateNetworkMonitoring = () => {
    if (networkMonitorHandler) return;
    isLoggingActive = true;
    displayCommands();
    console.log('\n -\x1b[36mNetwork monitoring started\x1b[0m\n');
    webSocketConnection.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    networkMonitorHandler = (data) => {
        if (!isLoggingActive) return;
        const message = JSON.parse(data);
        if (message.method === 'Network.requestWillBeSent' && message.params.request.postData) {
            if (jsonConfig.HideNetwork) {
                if (jsonConfig.HideNetwork.some(entry => entry === message.params.request.url)) return;
            }
            console.log(`\n\n  -\x1b[36mIntercepted Request\x1b[0m`);
            console.log(`\n   -\x1b[33mURL:\x1b[0m ${message.params.request.url}`);
            console.log(`\n   -\x1b[33mPost Data:\x1b[0m ${message.params.request.postData}`);
        }
    };
    webSocketConnection.on('message', networkMonitorHandler);
};
const terminateNetworkMonitoring = () => {
    if (!networkMonitorHandler) return;
    displayCommands();
    console.log('\n -\x1b[36mNetwork monitoring terminated\x1b[0m\n');
    webSocketConnection.send(JSON.stringify({ id: 1, method: 'Network.disable' }));
    webSocketConnection.off('message', networkMonitorHandler);
    networkMonitorHandler = undefined;
};
const executeCommand = (input) => {
    if (!isConnected) return;
    switch (input.trim()) {
        case 'dmp':
            dumpJavaScriptFiles();
            break;
        case 'net 2':
            if (networkMonitorHandler) {
                isLoggingActive = !isLoggingActive;
                console.log(isLoggingActive ? ' -\x1b[36mLogging enabled\x1b[0m' : ' -\x1b[36mLogging paused\x1b[0m');
            }
            break;
        case 'net 1':
            initiateNetworkMonitoring();
            break;
        case 'net 0':
            terminateNetworkMonitoring();
            break;
        default:
            break;
    }
};
readlineInterface.on('line', executeCommand);
console.clear();
establishWebSocketConnection();
// pkg index.js --target node14-win-x64 --output RunDevTools.exe