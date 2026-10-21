import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useStore, type AccountsStore } from "./store";
import { Badge } from "./ui";

/** The sidebar's Accounts row, with a count of signed-out accounts so they get noticed. */
export function AccountsSidebarRow({ theme, currentScreen, openScreen, store }: PluginSidebarItemProps & { store: AccountsStore }) {
  const { state } = useStore(store);
  const signedOut = state?.accounts.filter((account) => account.status === "signed_out").length ?? 0;
  return (
    <SidebarRow
      icon="Users"
      label={signedOut > 0 ? `Accounts, ${signedOut} signed out` : undefined}
      active={currentScreen?.screenId === "accounts"}
      onPress={() => openScreen({ screenId: "accounts" })}
      trailing={signedOut > 0 ? <Badge theme={theme} label={String(signedOut)} tone="warning" /> : null}
    />
  );
}
