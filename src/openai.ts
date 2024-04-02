import OpenAI from 'openai';
import * as vscode from 'vscode';
const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");

const openaiKeyName = 'openai.aiKey';
const geminiKeyName = 'google.aiKey';

export async function explainOutputs(cell: vscode.NotebookCell, context: vscode.ExtensionContext) {
    const outputs = cell.outputs;
    const newOutputs: vscode.NotebookCellOutput[] = [];
    let modified = false;
    for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i];
        let imageOutputItem: vscode.NotebookCellOutputItem | undefined;
        for (const item of output.items) {
            if (item.mime === 'image/png') {
                imageOutputItem = item;
                break;
            }
        }

        if (imageOutputItem) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Explaining image...'
            }, async (progress) => {
                const key = await getUserAiKey(context);
                if (!key) {
                    throw new Error('Missing API key');
                }

                const description =
                    key.provider === 'Google' ? await explainImageWithGemini(key.key, cell, imageOutputItem.data, context)
                        : await explainImage(key.key, cell, imageOutputItem.data, context);

                if (description) {
                    // create a markdown content which contains the description and the base64 image content
                    const markdownContent = new vscode.MarkdownString(description);
                    const imageData = Buffer.from(imageOutputItem.data).toString('base64');
                    const imageUrl = `data:image/jpeg;base64,${imageData}`;
                    markdownContent.appendMarkdown(`\n\n![image](${imageUrl})`);

                    const newOutput = new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(markdownContent.value, 'text/markdown')]);
                    newOutputs.push(newOutput);
                    modified = true;
                } else {
                    newOutputs.push(output);
                }

                progress.report({ increment: 100 });
            });
        } else {
            newOutputs.push(output);
        }
    }

    if (modified) {
        const newCell = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
        newCell.outputs = newOutputs;
        newCell.metadata = cell.metadata;
        newCell.executionSummary = cell.executionSummary;
        const notebookEdit = new vscode.NotebookEdit(new vscode.NotebookRange(cell.index, cell.index + 1), [newCell]);
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(cell.notebook.uri, [notebookEdit]);
        await vscode.workspace.applyEdit(workspaceEdit);
    }
}

async function explainImage(key: string, cell: vscode.NotebookCell, buffer: Uint8Array, context: vscode.ExtensionContext) {
    const imageData = Buffer.from(buffer).toString('base64');
    const cellInput = cell.document.getText();

    const text = `\n\nThis is an image output from a cell that contains the following text:
${cellInput}

Please describe the image in details for users who may not be able to see the image.
`;

    if (!key) {
        throw new Error('Missing API key');
    }

    const imageUrl = `data:image/jpeg;base64,${imageData}`;
    const openai = new OpenAI({ apiKey: key });
    const response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": text },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": imageUrl
                        },
                    },
                ],
            }
        ],
        max_tokens: 300,
    });

    return response.choices[0].message.content;
}

async function explainImageWithGemini(key: string, cell: vscode.NotebookCell, buffer: Uint8Array, context: vscode.ExtensionContext) {
    const MODEL_NAME = "gemini-1.0-pro-vision-latest";
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const generationConfig = {
        temperature: 0.4,
        topK: 32,
        topP: 1,
        maxOutputTokens: 4096,
    };

    const safetySettings = [
        {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
    ];

    const imageData = Buffer.from(buffer).toString('base64');
    const cellInput = cell.document.getText();

    const text = `\n\nThis is an image output from a cell that contains the following text:
${cellInput}

Please describe the image in details for users who may not be able to see the image.
`;

    const parts = [
        {
            inlineData: {
                mimeType: "image/png",
                data: imageData
            }
        },
        { text: text },
    ];

    const result = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig,
        safetySettings,
    });

    const response = result.response;
    return response.text();
}

async function getUserAiKey(context: vscode.ExtensionContext): Promise<{ provider: string; key: string } | undefined> {
    let selectedProvider = context.globalState.get<string>('vscode-notebook-vision.keyprovider');
    let keyName: string | undefined;
    if (selectedProvider === 'OpenAI') {
        keyName = openaiKeyName;
    } else if (selectedProvider === 'Google') {
        keyName = geminiKeyName;
    } else {
        const selected = await vscode.window.showQuickPick(['OpenAI', 'Google'], { placeHolder: 'Select the API key to use', ignoreFocusOut: true });
        if (selected === 'OpenAI') {
            keyName = openaiKeyName;
            selectedProvider = 'OpenAI';
            context.globalState.update('vscode-notebook-vision.keyprovider', selectedProvider);
        } else if (selected === 'Google') {
            keyName = geminiKeyName;
            selectedProvider = 'Google';
            context.globalState.update('vscode-notebook-vision.keyprovider', selectedProvider);
        }
    }

    if (!keyName || !selectedProvider) {
        return;
    }

    const storedKey = await context.secrets.get(keyName);
    if (storedKey) {
        return { provider: selectedProvider, key: storedKey };
    } else {
        const placeHolder = selectedProvider === 'Google' ? 'Enter your Google API key' : 'Enter your OpenAI API key';
        const prompt = selectedProvider === 'Google' ? '' : 'You can create an API key [here](https://platform.openai.com/api-keys)';
        const newKey = await vscode.window.showInputBox({
            placeHolder: placeHolder,
            prompt: prompt,
            ignoreFocusOut: true
        });
        if (newKey) {
            context.secrets.store(keyName, newKey);
            return { provider: selectedProvider, key: newKey };
        } else {
            return;
        }
    }
}

export function clearUserAiKey(context: vscode.ExtensionContext) {
    vscode.window.showQuickPick(['OpenAI', 'Google'], { placeHolder: 'Select the API key to clear', ignoreFocusOut: true }).then(async (selected) => {
        if (!selected) {
            return;
        }

        if (selected === 'OpenAI') {
            context.secrets.delete(openaiKeyName);
        } else if (selected === 'Google') {
            context.secrets.delete(geminiKeyName);
        }

        context.globalState.update('vscode-notebook-vision.keyprovider', undefined);
    });
}