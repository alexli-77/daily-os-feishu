/**
 * Console model-picker regression tests.
 *
 * Run with: `tsx scripts/tests/console-model-picker.test.ts`
 *
 * These exist because the picker shipped broken while every check passed. The
 * first version backed the Model field with a `<datalist>`; it type-checked, the
 * page rendered, and the browser bundle parsed — but a datalist filters its
 * suggestions against the input's current value, and that field always holds a
 * value (`default` at minimum). Clicking it opened nothing.
 *
 * So these tests drive the real shipped script against a DOM stub and assert on
 * behaviour: that a menu exists when the field is pre-filled, that picking an
 * option lands in the value the config save reads, and — the safety-critical
 * one for a shared instance — that a model id this build has never heard of is
 * preserved rather than silently rewritten.
 */
import assert from 'node:assert/strict';

import { JS } from '../../src/ui/server.js';

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

interface StubOption {
  value: string;
  textContent: string;
}

interface StubElement {
  id: string;
  value: string;
  hidden: boolean;
  innerHTML: string;
  options: StubOption[];
  focus(): void;
  addEventListener(): void;
  dispatchEvent(): void;
}

interface PickerHandle {
  select: StubElement;
  input: StubElement;
  provider: StubElement;
  updateModelSuggestions: () => void;
  onModelSelectChange: () => void;
}

/**
 * Evaluate the shipped console script with just enough DOM to exercise the
 * model picker, and hand back the two functions plus the elements they drive.
 */
function loadPicker(initial: { provider: string; model: string }): PickerHandle {
  const makeElement = (id: string, value = ''): StubElement => {
    const element: StubElement = {
      id,
      value,
      hidden: false,
      innerHTML: '',
      options: [],
      focus() {},
      addEventListener() {},
      dispatchEvent() {},
    };
    // Parsing <option> out of innerHTML mirrors what a browser does, so the
    // assertions can read `options` the way page code would.
    Object.defineProperty(element, 'innerHTML', {
      get: () => element.options.map((o) => `<option value="${o.value}">${o.textContent}</option>`).join(''),
      set: (html: string) => {
        element.options = Array.from(String(html).matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)).map((m) => ({
          value: m[1],
          textContent: m[2],
        }));
      },
    });
    return element;
  };

  const elements = new Map<string, StubElement>([
    ['llm-model-select', makeElement('llm-model-select')],
    ['llm-model', makeElement('llm-model', initial.model)],
    ['llm-provider', makeElement('llm-provider', initial.provider)],
  ]);

  // The console binds listeners to many elements at load time. Auto-create any
  // id we did not seed so that setup runs; the three we care about are seeded
  // above and shared, so assertions read the same objects the script mutates.
  const documentStub = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id)!;
    },
    querySelectorAll: () => [] as unknown[],
    addEventListener() {},
    title: '',
  };
  // Timers are stubbed to no-ops so the console's deferred work (toasts, poll
  // loops) never runs: this test is about the picker, and a stray callback
  // firing after the assertions would crash the runner.
  const windowStub = {
    location: { search: '', pathname: '/console', hash: '' },
    history: { replaceState() {} },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  };
  const storageStub = { getItem: () => null, setItem() {}, removeItem() {} };

  // Bare globals the console script touches at load time. Keep this list in
  // step with the script: a missing one surfaces as "X is not defined" here.
  const factory = new Function(
    'document',
    'window',
    'location',
    'history',
    'sessionStorage',
    'localStorage',
    'fetch',
    'navigator',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    `${JS}
     return { updateModelSuggestions, onModelSelectChange, MODEL_SUGGESTIONS };`,
  );
  const api = factory(
    documentStub,
    windowStub,
    windowStub.location,
    windowStub.history,
    storageStub,
    storageStub,
    () => Promise.resolve({ json: () => Promise.resolve({}) }),
    { clipboard: {} },
    windowStub.setTimeout,
    windowStub.clearTimeout,
    windowStub.setInterval,
    windowStub.clearInterval,
  ) as { updateModelSuggestions: () => void; onModelSelectChange: () => void };

  return {
    select: elements.get('llm-model-select')!,
    input: elements.get('llm-model')!,
    provider: elements.get('llm-provider')!,
    updateModelSuggestions: api.updateModelSuggestions,
    onModelSelectChange: api.onModelSelectChange,
  };
}

test('a pre-filled field still offers a full menu (the datalist regression)', () => {
  const picker = loadPicker({ provider: 'codex', model: 'default' });
  picker.updateModelSuggestions();

  assert.ok(picker.select.options.length > 2, 'the menu is populated, not filtered down to the current value');
  assert.equal(picker.select.value, 'default', 'the configured value is the selected one');
  assert.ok(picker.input.hidden, 'the free-text box stays out of the way for a known model');
  const values = picker.select.options.map((option) => option.value);
  assert.ok(values.includes('gpt-5.6-sol'), 'other models are reachable without clearing the field first');
  assert.ok(values.includes('__custom__'), 'an escape hatch for unknown ids is always present');
});

test('picking an option writes through to the field the config save reads', () => {
  const picker = loadPicker({ provider: 'codex', model: 'default' });
  picker.updateModelSuggestions();

  picker.select.value = 'gpt-5.4-mini';
  picker.onModelSelectChange();
  assert.equal(picker.input.value, 'gpt-5.4-mini', '#llm-model is the value collect() reads');
  assert.ok(picker.input.hidden);
});

test('Custom… reveals the free-text input instead of forcing a listed id', () => {
  const picker = loadPicker({ provider: 'codex', model: 'default' });
  picker.updateModelSuggestions();

  picker.select.value = '__custom__';
  picker.onModelSelectChange();
  assert.equal(picker.input.hidden, false, 'the operator can type an id we do not ship');
});

test('an unshipped model id is preserved, never silently rewritten', () => {
  // The reason this is a <select> with an injected option rather than a plain
  // <select>: model ids outrun this build. On a shared instance, opening the
  // page must not rewrite another operator's configured model.
  const picker = loadPicker({ provider: 'codex', model: 'gpt-9-unreleased' });
  picker.updateModelSuggestions();

  assert.equal(picker.select.value, 'gpt-9-unreleased', 'the unknown id is selected, not replaced');
  assert.equal(picker.input.value, 'gpt-9-unreleased', 'and it is still what would be saved');
  assert.match(picker.select.options[0].textContent, /current setting/, 'it is surfaced as the current setting');
});

test('suggestions follow the provider rather than always offering Codex ids', () => {
  const codex = loadPicker({ provider: 'codex', model: 'default' });
  codex.updateModelSuggestions();
  const claude = loadPicker({ provider: 'claude', model: 'default' });
  claude.updateModelSuggestions();

  assert.ok(codex.select.options.some((option) => option.value.startsWith('gpt-')));
  assert.ok(claude.select.options.some((option) => option.value.startsWith('claude-')));
  assert.ok(!claude.select.options.some((option) => option.value.startsWith('gpt-')), 'no Codex ids under the Claude provider');
});

function run(): void {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
