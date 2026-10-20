import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { nextRefill, roomTone, shortLabel, usedOf } from "../shared/format";
import { FAMILY_HEADING, type AccountView, type Family, type StateView } from "../shared/model";
import { toneColor, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Where work can go right now: one lane per provider, how much of it is used, and the
 * account the next agent will start on marked. Tapping an account opens it below.
 */
export function CapacityStrip({
  theme,
  state,
  families,
  compact,
  onSelect,
}: {
  theme: Theme;
  state: StateView;
  families: readonly Family[];
  compact: boolean;
  onSelect(accountId: string): void;
}) {
  const colors = theme.colors;
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        paddingVertical: 4,
      }}
    >
      {families.map((family, index) => {
        const accounts = state.accounts.filter((account) => account.family === family);
        if (accounts.length === 0) return null;
        return (
          <Lane
            key={family}
            theme={theme}
            family={family}
            accounts={accounts}
            nextId={state.nextUp[family] ?? null}
            compact={compact}
            divided={index > 0}
            onSelect={onSelect}
          />
        );
      })}
    </View>
  );
}

function Lane({
  theme,
  family,
  accounts,
  nextId,
  compact,
  divided,
  onSelect,
}: {
  theme: Theme;
  family: Family;
  accounts: AccountView[];
  nextId: string | null;
  compact: boolean;
  divided: boolean;
  onSelect(accountId: string): void;
}) {
  const text = useText(theme);
  const colors = theme.colors;
  const usable = accounts.filter((account) => account.status === "ready").length;
  const limited = accounts.filter((account) => account.status === "limited");
  // The soonest an exhausted account frees up is the one number worth knowing when room is short.
  const soonest = limited
    .map((account) => ({ account, at: Date.parse(account.limitedUntil ?? "") }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)[0]?.account;
  // "Next up" only means something when there's a choice to make.
  const marked = usable >= 2 ? nextId : null;
  const summary = accounts.every((account) => account.status === "signed_out")
    ? "Signed out"
    : usable === 0
      ? soonest
        ? `All out · ${shortLabel(soonest, 12)} back ${nextRefill(soonest)}`
        : "Nothing usable"
      : `${usable} of ${accounts.length} ready`;

  // Every lane has the same shape: on narrow screens the label sits above the bar.
  const stacked = compact;
  return (
    <View
      style={{
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        gap: stacked ? 8 : compact ? 12 : 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: divided ? 1 : 0,
        borderTopColor: colors.border,
      }}
    >
      <View
        style={{
          width: stacked ? undefined : compact ? 118 : 132,
          flexDirection: stacked ? "row" : "column",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
          {FAMILY_HEADING[family]}
        </Text>
        <Text
          style={[
            text.small,
            { fontVariant: ["tabular-nums"], color: usable === 0 ? colors.statusDanger : colors.foregroundMuted },
          ]}
          numberOfLines={1}
        >
          {summary}
        </Text>
      </View>
      <PoolBar theme={theme} accounts={accounts} nextId={marked} compact={compact} onSelect={onSelect} />
    </View>
  );
}

/**
 * A provider's accounts as one pool (a single account is a pool of one): each account is an equal
 * share of the bar, and what it has used is stacked end to end, fullest first, so the filled length
 * is how much of the whole pool is used. Accounts that are signed out or disabled aren't in the pool.
 */
function PoolBar({
  theme,
  accounts,
  nextId,
  compact,
  onSelect,
}: {
  theme: Theme;
  accounts: AccountView[];
  nextId: string | null;
  compact: boolean;
  onSelect(accountId: string): void;
}) {
  const colors = theme.colors;
  const pool = accounts.filter((account) => roomTone(account) !== "off");
  const share = pool.length > 0 ? 100 / pool.length : 0;
  const ranked = pool.map((account) => ({ account, used: usedOf(account) })).sort((a, b) => (b.used ?? -1) - (a.used ?? -1));
  const total = ranked.reduce((sum, entry) => sum + ((entry.used ?? 0) * share) / 100, 0);
  const totalTone = total >= 95 ? "out" : total > 70 ? "low" : "room";
  const unknown = ranked.every((entry) => entry.used === null);
  const off = accounts.filter((account) => roomTone(account) === "off");
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 14 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Usage across the pool"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(total) }}
          style={{ flexDirection: "row", height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: "hidden" }}
        >
          {ranked.map(({ account, used }) =>
            used ? (
              <Pressable
                key={account.id}
                accessibilityLabel={`${account.label}: ${Math.round(used)}% used`}
                onPress={() => onSelect(account.id)}
                style={{
                  width: `${(used * share) / 100}%`,
                  height: 8,
                  backgroundColor: toneColor(theme, roomTone(account)),
                  borderRightWidth: 2,
                  borderRightColor: colors.surface1,
                }}
              />
            ) : null,
          )}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2 }}>
          {[...ranked.map((entry) => entry.account), ...off].map((account) => (
            <PoolName
              key={account.id}
              theme={theme}
              account={account}
              next={account.id === nextId}
              alone={accounts.length === 1}
              onPress={() => onSelect(account.id)}
            />
          ))}
        </View>
      </View>
      <View style={{ alignItems: "flex-end", minWidth: compact ? 56 : 92 }}>
        <Text
          style={{
            color: pool.length === 0 || unknown ? colors.foregroundMuted : toneColor(theme, totalTone),
            fontSize: 15,
            fontWeight: "700",
            fontVariant: ["tabular-nums"],
            letterSpacing: -0.2,
          }}
        >
          {pool.length === 0 ? "off" : unknown ? "—" : `${Math.round(total)}%`}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {pool.length === 0
            ? ""
            : unknown
              ? "not reported"
              : accounts.length === 1
                ? "used"
                : compact
                  ? "pool used"
                  : "of the pool used"}
        </Text>
      </View>
    </View>
  );
}

/** "Work 62%", "Team back in 48m", "ChatGPT off": the account behind each piece of the bar. */
function PoolName({
  theme,
  account,
  next,
  alone,
  onPress,
}: {
  theme: Theme;
  account: AccountView;
  next: boolean;
  /** The only account: its number is already the lane's total, so only a limit is worth repeating. */
  alone: boolean;
  onPress(): void;
}) {
  const colors = theme.colors;
  const tone = roomTone(account);
  const used = usedOf(account);
  const detail =
    account.status === "limited"
      ? `back ${nextRefill(account) ?? "later"}`
      : tone === "off"
        ? "off"
        : used === null
          ? "—"
          : `${Math.round(used)}%`;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", gap: 4, opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        style={{ color: next ? colors.accent : colors.foregroundMuted, fontSize: 11, fontWeight: next ? "700" : "500" }}
        numberOfLines={1}
      >
        {next ? "▸ " : ""}
        {shortLabel(account, 14)}
      </Text>
      {alone && account.status !== "limited" ? null : (
        <Text
          style={{
            color: tone === "out" ? colors.statusDanger : tone === "low" ? colors.statusWarning : colors.foregroundMuted,
            fontSize: 11,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {detail}
        </Text>
      )}
    </Pressable>
  );
}
