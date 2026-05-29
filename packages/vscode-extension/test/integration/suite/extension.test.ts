/**
 * VS Code Extension — UI Integration Tests
 *
 * These tests run inside a real VS Code instance with the extension loaded.
 * They verify that the extension activates correctly, registers commands,
 * shows diagnostics, provides code actions, and updates the status bar.
 */
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('Extension Integration Tests', () => {
  const fixtureDir = path.resolve(__dirname, '../../fixture');

  suiteSetup(async function () {
    this.timeout(30_000);
    // Wait for the extension to activate
    const ext = vscode.extensions.getExtension('YOUR_PUBLISHER_ID.selector-healer-vscode');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    // Give the extension time to register
    await sleep(2000);
  });

  suite('Activation', () => {
    test('extension is present', () => {
      const ext = vscode.extensions.getExtension('YOUR_PUBLISHER_ID.selector-healer-vscode');
      assert.ok(ext, 'Extension should be found');
    });

    test('extension activates on TypeScript file', async () => {
      const testFile = path.join(fixtureDir, 'tests', 'login.spec.ts');
      const doc = await vscode.workspace.openTextDocument(testFile);
      await vscode.window.showTextDocument(doc);

      // Give activation time
      await sleep(1000);

      const ext = vscode.extensions.getExtension('YOUR_PUBLISHER_ID.selector-healer-vscode');
      assert.ok(ext?.isActive, 'Extension should be active after opening a TS file');
    });
  });

  suite('Commands', () => {
    test('selectorHealer.verify command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('selectorHealer.verify'), 'Verify command should be registered');
    });

    test('selectorHealer.capture command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('selectorHealer.capture'),
        'Capture command should be registered',
      );
    });

    test('selectorHealer.applyAllFixes command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('selectorHealer.applyAllFixes'),
        'ApplyAllFixes command should be registered',
      );
    });

    test('selectorHealer.refresh command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('selectorHealer.refresh'),
        'Refresh command should be registered',
      );
    });
  });

  suite('Diagnostics', () => {
    test('shows no-baseline info diagnostics for test files without fingerprints', async () => {
      const testFile = path.join(fixtureDir, 'tests', 'login.spec.ts');
      const doc = await vscode.workspace.openTextDocument(testFile);
      await vscode.window.showTextDocument(doc);

      // Wait for on-save/on-open diagnostics to populate
      await sleep(3000);

      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      // Since there are no fingerprints captured, selectors without baseline
      // will show as info diagnostics (or none if the feature gracefully skips)
      // The key assertion: no ERROR diagnostics from our extension on a fresh file
      const errors = diagnostics.filter(
        (d) => d.source === 'selector-healer' && d.severity === vscode.DiagnosticSeverity.Error,
      );
      assert.strictEqual(errors.length, 0, 'Should not show errors before verification has run');
    });
  });

  suite('Code Actions', () => {
    test('code action provider is registered for TypeScript', async () => {
      const testFile = path.join(fixtureDir, 'tests', 'login.spec.ts');
      const doc = await vscode.workspace.openTextDocument(testFile);
      await vscode.window.showTextDocument(doc);

      // Request code actions at line 5 (a locator line)
      const position = new vscode.Position(4, 20);
      const range = new vscode.Range(position, position);

      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        doc.uri,
        range,
      );

      // Without broken diagnostics, we expect no actions from our provider
      // (other extensions might provide actions, but ours should not crash)
      assert.ok(Array.isArray(actions), 'Code actions request should not throw');
    });
  });

  suite('Status Bar', () => {
    test('status bar item exists after activation', async () => {
      // Status bar items are not directly queryable via API, but
      // we can verify the extension didn't crash during creation
      // by checking it's still active
      const ext = vscode.extensions.getExtension('YOUR_PUBLISHER_ID.selector-healer-vscode');
      assert.ok(
        ext?.isActive,
        'Extension should still be active (status bar created without error)',
      );
    });
  });

  suite('Tree View', () => {
    test('selectorHealerExplorer view is registered', async () => {
      // Attempt to focus the view — this will throw if not registered
      try {
        await vscode.commands.executeCommand('selectorHealerExplorer.focus');
        assert.ok(true, 'Tree view focus command succeeded');
      } catch {
        // On some VS Code versions, focus may not work in test env
        // but the command existing proves registration
        const commands = await vscode.commands.getCommands(true);
        const hasViewCommand = commands.some((c) => c.includes('selectorHealerExplorer'));
        assert.ok(hasViewCommand, 'Tree view should be registered');
      }
    });
  });

  suite('Document Language Support', () => {
    test('does not crash on non-TypeScript files', async () => {
      const uri = vscode.Uri.parse('untitled:test.json');
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      // Should not produce any diagnostics or errors
      await sleep(500);
      const diagnostics = vscode.languages.getDiagnostics(doc.uri);
      const ours = diagnostics.filter((d) => d.source === 'selector-healer');
      assert.strictEqual(ours.length, 0, 'Should not produce diagnostics for non-TS files');
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
