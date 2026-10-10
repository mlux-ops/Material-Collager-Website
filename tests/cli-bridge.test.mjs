import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeArgs,
  claudeStdin,
  claudeUsesSubscription,
  CODEX_DISABLED_FEATURES,
  codexArgs,
  codexPrompt,
  codexUsesChatGpt,
  inspectClaudeEvent,
  isAllowedHost,
  isAllowedOrigin,
  MAX_IMAGES,
  MAX_INSTRUCTION_CHARS,
  PROVIDERS,
  resolveExecutable,
  scrubEnv,
  SYSTEM_PROMPT,
  validateRunPayload,
} from "../scripts/cli-bridge/lib.mjs";
import { CLI_DEFAULT_MODEL, CLI_MODELS } from "../app/components/workbench/nodes/cliAssistant.manifest.ts";

const PNG = { imageBase64: "iVBORw0KGgo=", mimeType: "image/png" };

test("scrubEnv drops every API key and Claude session variable a CLI could bill or inherit", () => {
  // Lower-case names count too: Windows env names are case-insensitive.
  const dropped = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "anthropic_auth_token",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDECODE",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
  ];
  const kept = { PATH: "C:\\bin", USERPROFILE: "C:\\Users\\me" };
  const input = { ...kept, ...Object.fromEntries(dropped.map((name) => [name, "x"])) };
  assert.deepEqual(scrubEnv(input), kept);
});

test("host check refuses rebinding names and other ports", () => {
  assert.equal(isAllowedHost("127.0.0.1:4795", 4795), true);
  assert.equal(isAllowedHost("localhost:4795", 4795), true);
  assert.equal(isAllowedHost("evil.example:4795", 4795), false);
  assert.equal(isAllowedHost("127.0.0.1:3000", 4795), false);
  assert.equal(isAllowedHost(undefined, 4795), false);
});

test("origin check is an exact allowlist match", () => {
  const allowed = ["http://localhost:3000"];
  assert.equal(isAllowedOrigin("http://localhost:3000", allowed), true);
  assert.equal(isAllowedOrigin("http://localhost:3000.evil.example", allowed), false);
  assert.equal(isAllowedOrigin("null", allowed), false);
  assert.equal(isAllowedOrigin(undefined, allowed), false);
});

test("validateRunPayload applies the assist route's caps and model allowlists", () => {
  const ok = validateRunPayload({ provider: "claude", instruction: "  hi  ", images: [PNG] });
  assert.deepEqual(ok, { provider: "claude", model: "sonnet", instruction: "hi", images: [{ data: PNG.imageBase64, mimeType: "image/png" }] });
  assert.equal(validateRunPayload({ provider: "codex", instruction: "hi" }).model, "default");

  const rejects = (body, status) => assert.throws(() => validateRunPayload(body), (error) => error.status === status);
  for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    assert.equal(validateRunPayload({ provider: "claude", model, instruction: "hi" }).model, model);
  }
  rejects({ provider: "claude", model: "claude-opus-5-5-extra", instruction: "hi" }, 400);
  rejects(null, 400);
  rejects({ provider: "gemini", instruction: "hi" }, 400);
  rejects({ provider: "claude", model: "claude-opus-4", instruction: "hi" }, 400);
  rejects({ provider: "codex", model: "gpt-5", instruction: "hi" }, 400);
  rejects({ provider: "claude", instruction: "   " }, 400);
  rejects({ provider: "claude", instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1) }, 400);
  rejects({ provider: "claude", instruction: "hi", images: Array(MAX_IMAGES + 1).fill(PNG) }, 400);
  rejects({ provider: "claude", instruction: "hi", images: [{ imageBase64: PNG.imageBase64, mimeType: "image/gif" }] }, 400);
  rejects({ provider: "claude", instruction: "hi", images: [{ imageBase64: "not base64!", mimeType: "image/png" }] }, 400);
});

test("claude runs with no tools, no user settings, no MCP and no saved session", () => {
  const args = claudeArgs("haiku");
  const valueOf = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueOf("--tools"), "");
  assert.equal(valueOf("--setting-sources"), "project");
  assert.equal(valueOf("--system-prompt"), SYSTEM_PROMPT);
  assert.equal(valueOf("--model"), "haiku");
  for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  // --bare never reads the OAuth login, so it would force API-key billing.
  assert.ok(!args.includes("--bare"));
});

test("claude stdin carries images as base64 content blocks ahead of the text", () => {
  const line = claudeStdin("describe", [{ data: "AAAA", mimeType: "image/webp" }]);
  assert.ok(line.endsWith("\n"));
  const message = JSON.parse(line);
  assert.equal(message.type, "user");
  assert.deepEqual(message.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
    { type: "text", text: "describe" },
  ]);
});

test("inspectClaudeEvent flags an init that is not on the subscription and reads the result", () => {
  assert.deepEqual(
    inspectClaudeEvent(JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" })),
    { kind: "init", subscription: true, apiKeySource: "none" },
  );
  assert.equal(inspectClaudeEvent(JSON.stringify({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" })).subscription, false);
  assert.equal(inspectClaudeEvent(JSON.stringify({ type: "system", subtype: "init" })).subscription, false);
  assert.deepEqual(
    inspectClaudeEvent(JSON.stringify({ type: "result", result: "Red", is_error: false })),
    { kind: "result", text: "Red", isError: false },
  );
  assert.equal(inspectClaudeEvent("not json"), null);
  assert.equal(inspectClaudeEvent(JSON.stringify({ type: "assistant" })), null);
});

test("codex runs read-only with every tool feature disabled and the prompt on stdin", () => {
  const args = codexArgs({ model: "default", workDir: "W", imagePaths: ["W/a.png", "W/b.png"], outFile: "W/out.txt" });
  assert.equal(args[0], "exec");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
  const disabled = args.flatMap((arg, index) => (arg === "--disable" ? [args[index + 1]] : []));
  assert.deepEqual(disabled, CODEX_DISABLED_FEATURES);
  assert.ok(disabled.includes("shell_tool") && disabled.includes("unified_exec"));
  assert.ok(!args.includes("-m"), "default model sends no -m");
  assert.deepEqual(args.slice(-9), ["-C", "W", "-i", "W/a.png", "-i", "W/b.png", "-o", "W/out.txt", "-"]);
  assert.ok(!args.some((arg) => arg.startsWith("--dangerously")));
  assert.ok(codexPrompt("hi").startsWith(SYSTEM_PROMPT) && codexPrompt("hi").endsWith("hi"));
});

test("a named codex model is passed with -m and must be on the allowlist", () => {
  const args = codexArgs({ model: "gpt-6-sol", workDir: "W", imagePaths: [], outFile: "W/out.txt" });
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-sol");
  assert.equal(validateRunPayload({ provider: "codex", model: "gpt-5.6-luna", instruction: "hi" }).model, "gpt-5.6-luna");
  assert.throws(() => validateRunPayload({ provider: "codex", model: "gpt-reserve", instruction: "hi" }), (error) => error.status === 400);
});

test("subscription checks accept only a claude.ai login and a ChatGPT login", () => {
  assert.equal(claudeUsesSubscription(JSON.stringify({ authMethod: "claude.ai" })), true);
  assert.equal(claudeUsesSubscription(JSON.stringify({ authMethod: "api_key" })), false);
  assert.equal(claudeUsesSubscription("garbage"), false);
  assert.equal(codexUsesChatGpt("Logged in using ChatGPT"), true);
  assert.equal(codexUsesChatGpt("Logged in using an API key"), false);
  assert.equal(codexUsesChatGpt("Not logged in"), false);
});

test("resolveExecutable follows an npm .cmd shim to its .exe and never returns the shim", () => {
  const files = new Map([
    ["C:\\npm\\claude.cmd", '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'],
    ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", ""],
    ["C:\\codex\\codex.exe", ""],
    ["C:\\broken\\other.cmd", "@ECHO off\r\nnode cli.js %*\r\n"],
  ]);
  const io = { platform: "win32", exists: (file) => files.has(file), readFile: (file) => files.get(file) };
  assert.equal(
    resolveExecutable("claude", { ...io, pathEnv: "C:\\npm;C:\\codex" }),
    "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  );
  assert.equal(resolveExecutable("codex", { ...io, pathEnv: "C:\\npm;C:\\codex" }), "C:\\codex\\codex.exe");
  assert.equal(resolveExecutable("other", { ...io, pathEnv: "C:\\broken" }), null);
  assert.equal(
    resolveExecutable("claude", { platform: "linux", pathEnv: "/usr/bin:/opt/bin", exists: (file) => file === "/opt/bin/claude", readFile: () => "" }),
    "/opt/bin/claude",
  );
});

test("the workbench nodes' model lists mirror the bridge allowlist", () => {
  for (const provider of ["claude", "codex"]) {
    assert.deepEqual([...CLI_MODELS[provider]], PROVIDERS[provider].models);
    assert.equal(CLI_DEFAULT_MODEL[provider], PROVIDERS[provider].defaultModel);
  }
});
