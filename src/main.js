"use strict";

const path = require("path");
const vscode = require("vscode");
const ChildProcess = require('child_process');
const { providers } = require('./providers');

let ignoreNextSearch = false;
let previousLocation = null;

function ripGrepResultToCodeLocation(result) {
    const data = result.split(':');

    let filePath = data[0];
    let line = parseInt(data[1], 10) - 1;
    let lineEnd = line;
    let column = parseInt(data[2], 10) - 1;
    let columnEnd = column;

    return new vscode.Location(
        vscode.Uri.file(filePath),
        new vscode.Range(line, column, lineEnd, columnEnd)
    );
}

function openLocation(location) {
    return vscode.workspace.openTextDocument(location.uri).then(function (doc) {
        return vscode.window.showTextDocument(doc).then(function (editor) {
            editor.selection = new vscode.Selection(
                location.range.start,
                location.range.end
            );
            editor.revealRange(location.range);
        });
    });
}

function openLocations(locations) {
    if (locations.length === 1) {
        return openLocation(locations[0]);
    }

    var picks = locations.map(function (l) { return ({
        label: path.basename(l.uri.fsPath), //vscode.workspace.asRelativePath(l.uri) + ":" + (l.range.start.line + 1),
        description: vscode.workspace.asRelativePath(l.uri) + ":" + (l.range.start.line + 1), // l.uri.fsPath,
        location: l
    }); });
    return vscode.window.showQuickPick(picks).then(function (pick) {
        return pick && openLocation(pick.location);
    });
}

function getSearchOptions(word, fileExt) {
    const providersToUse = [];

    let scanRegexes = [];
    let scanFiles = [];

    for (let providerName in providers) {
        let provider = providers[providerName];
        if (provider.extensions.includes("*" + fileExt)) {
            providersToUse.push(providerName);
            if (provider.dependencies) {
                provider.dependencies.map(x => providersToUse.push(x));
            }
        }
    }

    for (let i = 0; i < providersToUse.length; i++) {
        let provider = providers[providersToUse[i]];

        scanRegexes.push(...provider.regexes.map(x => x.source));
        scanFiles.push(...provider.extensions);
    }

    return {
        regex: scanRegexes.join('|').replace(/{word}/g, word),
        fileTypes: scanFiles,
    }
}

function getConfiguration() {
    return vscode.workspace.getConfiguration('dumbJump');
}

function getRipGrepPath() {
    return getConfiguration().get('pathToRipGrep') || "rg"
}

function getSearchAllWorkspaceFolders() {
    return getConfiguration().get('searchAllWorkspaceFolders') || false
}

/**
 * Given a document return an array of paths to search depending on the
 * workspace and the setting to search all workspace folders
 */
function searchPaths(document) {
    const mapToPath = workspace => workspace.uri.fsPath;

    if (getSearchAllWorkspaceFolders()) {
        return vscode.workspace.workspaceFolders.map(mapToPath);
    } else {
        const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
        return [workspace].filter(Boolean).map(mapToPath);
    }
}

async function ripGrepSearch(scanPaths, word, fileExt) {
    if(scanPaths.length === 0) {
        vscode.window.showErrorMessage(`[vscode-dumb-jump] No paths to search.`)
        return [];
    }

    const { regex, fileTypes } = getSearchOptions(word, fileExt)

    const args = fileTypes.map(x => `--glob=${x}`);
    // args.push(...openedFiles.map(x => `--glob=!${x}`));
    // '--no-ignore-vcs', '--ignore-case'
    args.push(...[
        '--line-number', '--column', regex,
    ]);

    args.push(...scanPaths);

    return new Promise((resolve, reject) => {
        const runRipgrep = ChildProcess.spawn(getRipGrepPath(), args);

        runRipgrep.stdout.setEncoding('utf8');
        runRipgrep.stderr.setEncoding('utf8');

        let results = "";

        runRipgrep.stdout.on('data', (data) => {
            results += data.toString();
        });

        runRipgrep.on('close', function (code) {
            let locations = results.split("\n").filter((el) => { return !!el }).map(ripGrepResultToCodeLocation);
            resolve(locations);

        });

        runRipgrep.on('error', (error) => {
            if (error.code === 'ENOENT') {
                vscode.window.showErrorMessage(`[vscode-dumb-jump] "ripgrep" is not found in $PATH.`)
            } else {
                throw error;
            }
        });
    });
}

async function provideDefinition(document, pos, token) {
    if (ignoreNextSearch) return [];

    try {
        const range = document.getWordRangeAtPosition(pos);
        if (!range) return Promise.resolve([]);
        const word = document.getText(range);

        ignoreNextSearch = true;
        const otherProviderResults = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, pos);
        ignoreNextSearch = false;

        let dumbDefinitions = await ripGrepSearch(searchPaths(document), word, path.extname(document.fileName));

        return dumbDefinitions;

    } catch (error) {
        console.error('[vscode-dumb-jump]', error);
        ignoreNextSearch = false;
        throw error;
    }
}

function jump(editor) {
    const document = editor.document, selection = editor.selection;
    const range = document.getWordRangeAtPosition(selection.active);
    const word = document.getText(range);

    if (range) {
        ripGrepSearch(searchPaths(document), word, path.extname(document.fileName)).then(locations => {
            if (locations.length > 0) {
                previousLocation = new vscode.Location(vscode.Uri.file(document.fileName), range);
                openLocations(locations);
            }
        });
    }
}

function back(editor) {
    if (previousLocation != null) {
        return openLocation(previousLocation);
    }
}

function activate(context) {
    // const langs = [
    //     'javascript',
    //     'javascriptreact',
    //     'typescript',
    //     'typescriptreact',
    //     'vue',
    //     'python',
    // ];

    // context.subscriptions.push(
    //     langs.map(lang => {
    //         vscode.languages.registerDefinitionProvider(lang, {
    //             provideDefinition: provideDefinition,
    //         });
    //     })
    // );

    vscode.commands.registerTextEditorCommand('vscode-dumb-jump.jump', jump);
    vscode.commands.registerTextEditorCommand('vscode-dumb-jump.back', back);
}

exports.activate = activate;
