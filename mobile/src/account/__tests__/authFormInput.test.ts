import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Exercise the form's real event handlers and submission without a native IME.
// The state harness allows each native text event to be followed by a render.
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react') & { default?: typeof import('react') }>();
  const useState = (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return [state.values[index], (value: unknown) => { state.values[index] = value; }];
  };
  return { ...actual, default: { ...(actual.default ?? actual), useState }, useState };
});
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Linking: {}, Text: 'Text',
  TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('lucide-react-native', () => ({ KeyRound: 'KeyRound', LogIn: 'LogIn', UserPlus: 'UserPlus' }));

import { AccountAuthForm } from '../AccountAuthForm';

type Element = ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function form(view: 'register' | 'login' = 'register') {
  const onRegister = vi.fn(async () => undefined);
  const onLogin = vi.fn(async () => undefined);
  const props = {
    view, busy: false, error: null, notice: null,
    lifecycleConfig: {
      api_available: true, lifecycle_enabled: true,
      current_terms_version: '1.0', current_privacy_version: '1.0', reaccept_days: 365,
    },
    onRegister, onLogin, onViewChange: vi.fn(), onForgotPassword: vi.fn(),
  };
  const render = () => {
    state.cursor = 0;
    return elements(AccountAuthForm(props));
  };
  const input = (label: string) => render().find((element) => (
    (element.type as unknown) === 'TextInput' && element.props.accessibilityLabel === label
  ))!;
  const enter = (label: string, text: string) => input(label).props.onChangeText(text);
  const submit = () => render().find((element) => (
    element.props.accessibilityRole === 'button' && 'disabled' in element.props
  ))!.props.onPress();
  return { render, input, enter, submit, onRegister, onLogin };
}

beforeEach(() => { state.values = []; state.cursor = 0; });

describe('auth form native text events', () => {
  it('keeps each full composing value intact, including uppercase, without appending prefixes', () => {
    const ui = form();
    for (const word of ['francesco', 'Francesco']) {
      for (let length = 1; length <= word.length; length++) {
        const composing = word.slice(0, length);
        ui.enter('Username', composing);
        expect(ui.input('Username').props.value).toBe(composing);
      }
    }
  });

  it('accepts autofill/paste, selection replacement and deletion without rewriting input', () => {
    const ui = form();
    for (const text of ['Francesco_16', 'Francesca_16', 'Francesca_', '']) {
      ui.enter('Username', text);
      expect(ui.input('Username').props.value).toBe(text);
    }
    expect(ui.input('Username').props.textContentType).toBe('username');
    expect(ui.input('Username').props.accessibilityLabel).toBe('Username');
  });

  it('normalizes only the submitted username while preserving email and password', async () => {
    const ui = form();
    ui.enter('Username', 'Francesco_16');
    ui.enter('Email', 'Francesco@example.test');
    ui.enter('Password', 'MiXeD password_16');
    for (const consent of ui.render().filter((element) => (
      element.props.checked === false && typeof element.props.onPress === 'function'
    ))) consent.props.onPress();
    await ui.submit();
    expect(ui.onRegister).toHaveBeenCalledWith('Francesco@example.test', 'MiXeD password_16', 'francesco_16');
    expect(ui.input('Username').props.value).toBe('Francesco_16');
  });

  it('preserves full native values for login email and password', async () => {
    const ui = form('login');
    for (const label of ['Email', 'Password']) {
      for (const text of ['f', 'fr', 'fra', 'francesco', 'Francesco_16']) {
        ui.enter(label, text);
        expect(ui.input(label).props.value).toBe(text);
      }
    }
    ui.enter('Email', 'Francesco@example.test');
    await ui.submit();
    expect(ui.onLogin).toHaveBeenCalledWith('Francesco@example.test', 'Francesco_16');
    expect(ui.input('Password').props.secureTextEntry).toBe(true);
  });
});
