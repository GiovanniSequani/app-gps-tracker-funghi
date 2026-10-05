import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert } from 'react-native';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() }, Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('lucide-react-native', () => ({ Pause: 'Pause', Play: 'Play', Plus: 'Plus' }));

import { RecordingFieldControls, RecordingSessionControls } from '../RecordingControls';

type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function button(node: React.ReactNode, label: string) {
  return elements(node).find((element) => (
    element.props.accessibilityRole === 'button' && element.props.accessibilityLabel.startsWith(label)
  ))!;
}
const fieldProps = () => ({
  paused: false, busy: false, hasPoints: true, porciniCount: 3, finferliCount: 2,
  onAdd: vi.fn(), onResume: vi.fn(),
});
const sessionProps = () => ({
  paused: false, busy: false, pointCount: 123, onPause: vi.fn(), onFinish: vi.fn(),
});

beforeEach(() => vi.clearAllMocks());

describe('recording field controls', () => {
  it('adds the selected species in one tap and exposes no stop/pause action in the thumb area', () => {
    const props = fieldProps();
    const tree = RecordingFieldControls(props);
    button(tree, 'Aggiungi porcino').props.onPress();
    button(tree, 'Aggiungi finferlo').props.onPress();
    expect(props.onAdd.mock.calls).toEqual([['Porcino'], ['Finferlo']]);
    expect(elements(tree).filter((element) => element.props.accessibilityRole === 'button')).toHaveLength(2);
    expect(button(tree, 'Termina')).toBeUndefined();
    expect(button(tree, 'Metti in pausa')).toBeUndefined();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each([{ busy: true, hasPoints: true }, { busy: false, hasPoints: false }])(
    'disables add actions when busy or waiting for the first GPS point: %o',
    (state) => {
      const tree = RecordingFieldControls({ ...fieldProps(), ...state });
      for (const label of ['Aggiungi porcino', 'Aggiungi finferlo']) {
        expect(button(tree, label).props.disabled).toBe(true);
        expect(button(tree, label).props.accessibilityState.disabled).toBe(true);
      }
    },
  );

  it('shows only resume in the thumb area while paused and calls the existing handler', () => {
    const props = { ...fieldProps(), paused: true };
    const tree = RecordingFieldControls(props);
    expect(button(tree, 'Aggiungi')).toBeUndefined();
    button(tree, 'Riprendi').props.onPress();
    expect(props.onResume).toHaveBeenCalledOnce();
    expect(props.onAdd).not.toHaveBeenCalled();
  });
});

describe('recording session controls', () => {
  it('keeps recording running until the explicit finish confirmation is chosen', () => {
    const props = sessionProps();
    button(RecordingSessionControls(props), 'Termina').props.onPress();
    expect(props.onFinish).not.toHaveBeenCalled();
    expect(props.onPause).not.toHaveBeenCalled();
    const [, , actions, options] = vi.mocked(Alert.alert).mock.calls[0];
    expect(actions![0].style).toBe('cancel');
    expect(actions![0].onPress).toBeUndefined();
    expect(options?.cancelable).toBe(true);
    actions!.find((action) => action.text === 'Termina')!.onPress!();
    expect(props.onFinish).toHaveBeenCalledOnce();
  });

  it('pauses only from the separate top control', () => {
    const props = sessionProps();
    button(RecordingSessionControls(props), 'Metti in pausa').props.onPress();
    expect(props.onPause).toHaveBeenCalledOnce();
    expect(props.onFinish).not.toHaveBeenCalled();
  });

  it('keeps finish confirmation available while paused without another pause action', () => {
    const props = { ...sessionProps(), paused: true };
    const tree = RecordingSessionControls(props);
    expect(button(tree, 'Metti in pausa')).toBeUndefined();
    button(tree, 'Termina').props.onPress();
    expect(Alert.alert).toHaveBeenCalled();
    expect(props.onFinish).not.toHaveBeenCalled();
  });

  it('blocks further control actions while a tracking operation is running', () => {
    const props = { ...sessionProps(), busy: true };
    const tree = RecordingSessionControls(props);
    expect(button(tree, 'Metti in pausa').props.disabled).toBe(true);
    expect(button(tree, 'Termina').props.disabled).toBe(true);
    button(tree, 'Termina').props.onPress();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(props.onFinish).not.toHaveBeenCalled();
  });
});
