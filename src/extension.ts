import * as vscode from 'vscode';
import { clearUserAiKey, explainOutputs } from './openai';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-output-vision.explain', async (cell: vscode.NotebookCell) => { explainOutputs(cell, context); }),
		vscode.commands.registerCommand('vscode-output-vision.clearKey', async () => clearUserAiKey(context))
	);
}

export function deactivate() {}
