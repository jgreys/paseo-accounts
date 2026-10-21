import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { shownFamilies, useStore, type AccountsStore } from "./store";
import { Badge } from "./ui";

/** The sidebar's Accounts row, with a count of signed-out accounts so they get noticed. */
export function AccountsSidebarRow({ theme, currentScreen, openScreen, store }: PluginSidebarItemProps & { store: AccountsStore }) {
  const { state } = useStore(store);
  // Only accounts the Accounts screen lists, so the count matches what the user can fix there.
  const families = shownFamilies(state);
  const signedOut = state?.accounts.filter((account) => account.status === "signed_out" && families.includes(account.family)).length ?? 0;
  return (
    <SidebarRow
      icon="Users"
      active={currentScreen?.screenId === "accounts"}
      onPress={() => openScreen({ screenId: "accounts" })}
      trailing={signedOut > 0 ? <Badge theme={theme} label={String(signedOut)} tone="warning" /> : null}
    />
  );
}
