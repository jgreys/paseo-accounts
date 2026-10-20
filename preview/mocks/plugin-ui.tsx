import { useContext, type ReactNode } from "react";
import { Switch, Text, View } from "react-native";
import { PreviewColors } from "./colors";

export function SettingsCard({ children }: { children: ReactNode }) {
  const c = useContext(PreviewColors);
  return <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>{children}</View>;
}
export function SettingsSwitch(props: { label: string; hint?: string; value: boolean; disabled?: boolean; onValueChange(value: boolean): void }) {
  const c = useContext(PreviewColors);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }}>{props.label}</Text>
        {props.hint ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{props.hint}</Text> : null}
      </View>
      <Switch value={props.value} disabled={props.disabled} onValueChange={props.onValueChange} />
    </View>
  );
}
export const SettingsGroup = View;
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const c = useContext(PreviewColors);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{title}</Text>
      {children}
    </View>
  );
}

export function SettingsSelect(props: { label: string; hint?: string; value: string; options: ReadonlyArray<{ label: string; value: string }>; onValueChange(value: string): void; disabled?: boolean }) {
  const c = useContext(PreviewColors);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }}>{props.label}</Text>
        {props.hint ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{props.hint}</Text> : null}
      </View>
      <select value={props.value} onChange={(event) => props.onValueChange(event.target.value)} disabled={props.disabled}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </View>
  );
}
export function SettingsInput(props: { label: string; hint?: string; initialValue?: string; placeholder?: string; onChangeText(text: string): void }) {
  const c = useContext(PreviewColors);
  return (
    <View style={{ padding: 14, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }}>{props.label}</Text>
      {props.hint ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{props.hint}</Text> : null}
      <input defaultValue={props.initialValue} placeholder={props.placeholder} onChange={(event) => props.onChangeText(event.target.value)} />
    </View>
  );
}
export function SettingsAction(props: { label: string; actionLabel: string; onPress(): void; disabled?: boolean }) {
  const c = useContext(PreviewColors);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Text style={{ flex: 1, color: c.foreground, fontSize: 14 }}>{props.label}</Text>
      <button disabled={props.disabled} onClick={props.onPress}>{props.actionLabel}</button>
    </View>
  );
}
