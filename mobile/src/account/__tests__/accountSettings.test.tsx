import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
}));
vi.mock('lucide-react-native', () => ({
  FileText: 'FileText', KeyRound: 'KeyRound', LogOut: 'LogOut',
  Settings: 'Settings', UserRound: 'UserRound',
}));
vi.mock('../AccountRightsPanel', () => ({ AccountRightsPanel: 'AccountRightsPanel' }));

import { AccountProfileHeader, AccountSettings } from '../AccountSettings';

type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, any>>(node)) return [];
  if (typeof node.type === 'function') return [node, ...elements((node.type as (props: Record<string, any>) => React.ReactNode)(node.props))];
  return [node, ...elements(node.props.children)];
}
const props = () => ({
  username: 'utente_con_nome_lungo_24', email: 'nome.cognome.molto.lungo@example.test',
  accountState: 'active' as const, fullAccess: true,
  trackCount: 3, maxTracks: 100, maxFileSize: '10 MB', busy: false,
  error: null, notice: null, onChangePassword: vi.fn(), onSignOut: vi.fn(),
});
function button(tree: React.ReactNode, label: string) {
  return elements(tree).find((element) => element.props.accessibilityRole === 'button' &&
    elements(element).some((child) => child.props.children === label));
}

describe('area personale', () => {
  it('mostra identità completa e un ingresso alle impostazioni nel profilo', () => {
    const onOpenSettings = vi.fn();
    const tree = AccountProfileHeader({ username: props().username, email: props().email, onOpenSettings });
    expect(elements(tree).some((element) => element.props.children === props().username)).toBe(true);
    expect(elements(tree).some((element) => element.props.children === props().email)).toBe(true);
    expect(elements(tree).filter((element) => element.props.numberOfLines !== undefined)).toHaveLength(0);
    elements(tree).find((element) => element.props.accessibilityLabel === 'Apri impostazioni account')!.props.onPress();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('mostra le funzioni ordinarie, i documenti e i diritti per account attivo', () => {
    const values = props();
    const tree = AccountSettings(values);
    expect(button(tree, 'Cambia password')).toBeDefined();
    expect(elements(tree).find((element) => element.type === 'AccountRightsPanel')?.props.accountState).toBe('active');
    expect(elements(tree).filter((element) => element.props.accessibilityRole === 'link')).toHaveLength(3);
    button(tree, 'Cambia password')!.props.onPress();
    button(tree, 'Esci')!.props.onPress();
    expect(values.onChangePassword).toHaveBeenCalledOnce();
    expect(values.onSignOut).toHaveBeenCalledOnce();
  });

  it('mantiene export e cancellazione ma nasconde il cambio password senza accesso completo', () => {
    const tree = AccountSettings({ ...props(), accountState: 'restricted', fullAccess: false });
    expect(button(tree, 'Cambia password')).toBeUndefined();
    expect(elements(tree).find((element) => element.type === 'AccountRightsPanel')?.props.accountState).toBe('restricted');
    expect(button(tree, 'Esci')).toBeDefined();
  });

  it('in eliminazione mostra lo stato reale, i documenti e il logout', () => {
    const tree = AccountSettings({ ...props(), accountState: 'deletion_pending', fullAccess: false });
    expect(elements(tree).find((element) => element.type === 'AccountRightsPanel')?.props.accountState).toBe('deletion_pending');
    expect(button(tree, 'Cambia password')).toBeUndefined();
    expect(elements(tree).some((element) => element.props.children === 'Utilizzo account')).toBe(false);
    expect(elements(tree).filter((element) => element.props.accessibilityRole === 'link')).toHaveLength(3);
    expect(button(tree, 'Esci')).toBeDefined();
  });

  it('se lo stato non è verificabile espone soltanto documenti e uscita', () => {
    const tree = AccountSettings({ ...props(), accountState: null, fullAccess: false });
    expect(elements(tree).some((element) => element.type === 'AccountRightsPanel')).toBe(false);
    expect(button(tree, 'Cambia password')).toBeUndefined();
    expect(button(tree, 'Esci')).toBeDefined();
  });
});
