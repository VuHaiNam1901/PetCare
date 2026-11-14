import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatbotDisplayState } from '../src/utils/chatbot-display.js';
import { CHAT_OPEN_KEY } from '../src/utils/chat-session.js';

function setup(type, open = '1') {
  const historyKey = 'petcare.chatbot-conversation.v2.guest';
  const positionKey = 'petcare.chatbot-position.v1';
  const values = new Map([[CHAT_OPEN_KEY, open], [historyKey, 'saved transcript and session'], [positionKey, '{"x":800,"y":500}']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const state = () => createChatbotDisplayState({ storage: () => storage, navigation: () => type });
  return { values, state, historyKey, positionKey };
}

test('reload collapses only the panel, retaining the conversation, session and drag position', () => {
  const { values, state, historyKey, positionKey } = setup('reload');
  const display = state();
  assert.equal(display.initialOpen(), false);
  assert.equal(values.get(CHAT_OPEN_KEY), '0');
  assert.equal(values.get(historyKey), 'saved transcript and session');
  assert.equal(values.get(positionKey), '{"x":800,"y":500}');
  display.writeOpen(true);
  assert.equal(display.initialOpen(), true, 'a remount within this document does not reset a new user action');
  assert.equal(display.readOpen(), true);
});

test('ordinary navigation and back/forward retain the explicit open or closed state', () => {
  for (const type of ['navigate', 'back_forward']) {
    const { state } = setup(type);
    const firstPage = state();
    assert.equal(firstPage.initialOpen(), true);
    firstPage.writeOpen(false);
    assert.equal(state().initialOpen(), false);
    firstPage.writeOpen(true);
    assert.equal(state().initialOpen(), true);
  }
});

test('logout changes are observed and unavailable storage defaults to a collapsed panel', () => {
  const { state, values } = setup('navigate');
  const display = state();
  assert.equal(display.initialOpen(), true);
  values.set(CHAT_OPEN_KEY, '0');
  assert.equal(display.readOpen(), false);
  const blocked = createChatbotDisplayState({ storage() { throw new Error('blocked'); }, navigation: () => 'reload' });
  assert.equal(blocked.initialOpen(), false);
  assert.doesNotThrow(() => blocked.writeOpen(true));
  assert.equal(blocked.readOpen(), false);
});
