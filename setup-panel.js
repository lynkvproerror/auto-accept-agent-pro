/**
 * Setup Panel — CDP Setup WebView
 *
 * Guides users through enabling Chrome DevTools Protocol (CDP)
 * for their IDE. The actual setup logic is in relauncher.js.
 */

const vscode = require('vscode');
const { Relauncher } = require('./main_scripts/relauncher');

class SetupPanel {
    static currentPanel = null;

    static createOrShow(extensionUri, context) {
        const column = vscode.ViewColumn.One;

        if (SetupPanel.currentPanel) {
            SetupPanel.currentPanel._panel.reveal(column);
            return;
        }

        const relauncher = new Relauncher(msg => console.log(`[AutoAccept] ${msg}`));
        relauncher.showSetupPanel();
    }
}

module.exports = { SetupPanel };
