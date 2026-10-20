import * as Lucide from "lucide-react";
import { useContext, type ReactNode } from "react";
import { ScrollView as RNScrollView, FlatList as RNFlatList, Pressable, Text, TextInput as RNTextInput, View } from "react-native";

export const ScrollView = RNScrollView;
export const FlatList = RNFlatList;
export const TextInput = RNTextInput;

export function Icon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const Component = (Lucide as unknown as Record<string, React.ComponentType<{ size?: number; color?: string }>>)[name];
  return Component ? <Component size={size} color={color} /> : <View style={{ width: size, height: size, backgroundColor: "red" }} />;
}

import { PreviewColors as ThemeContext } from "./colors";


function ModalRoot({ title, open, onOpenChange, children }: { title: string; open: boolean; onOpenChange(open: boolean): void; children: ReactNode }) {
  const colors = useContext(ThemeContext);
  if (!open) return null;
  return (
    <View style={{ position: "fixed" as never, inset: 0, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <Pressable style={{ position: "absolute", inset: 0 } as never} onPress={() => onOpenChange(false)} />
      <View style={{ width: "92%", maxWidth: 480, backgroundColor: colors.surface1, borderRadius: 14, padding: 20, gap: 14, borderWidth: 1, borderColor: colors.border }}>
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{title}</Text>
        {children}
      </View>
    </View>
  );
}
function ModalContent({ children }: { children: ReactNode }) {
  return <View style={{ gap: 14 }}>{children}</View>;
}
export const Modal = Object.assign(ModalRoot, { Content: ModalContent });

export function useToast() {
  return {
    show: (message: string) => console.log("toast:", message),
    error: (message: string) => console.warn("toast error:", message),
  };
}

export async function copyText(text: string) {
  await navigator.clipboard?.writeText(text);
}
export function useRevealedText(text: string) {
  return text;
}
