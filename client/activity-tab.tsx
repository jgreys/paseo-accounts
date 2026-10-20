import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { formatAge } from "../shared/format";
import type { StateView } from "../shared/model";
import { SwitchRowSchema, type SwitchRow } from "../shared/timeline";
import { describeRow } from "./switch-row";
import { useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

const OUTCOME_ICON: Record<SwitchRow["outcome"], string> = {
  switched: "ArrowRightLeft",
  pending: "Clock",
  continued: "GitFork",
  stayed: "CircleAlert",
  reset: "TimerReset",
};

/** Every account switch across agents, newest first: which agent moved, from where to where, and why. */
export function ActivityTab({ theme, state, onOpenAgent }: { theme: Theme; state: StateView; onOpenAgent?: (agentId: string) => void }) {
  const text = useText(theme);
  const colors = theme.colors;
  const entries = state.activity
    .map((entry) => ({ ...entry, parsed: SwitchRowSchema.safeParse(entry.row) }))
    .filter((entry) => entry.parsed.success)
    .map((entry) => ({ agentId: entry.agentId, agentTitle: entry.agentTitle, row: entry.parsed.data as SwitchRow }));
  if (entries.length === 0) {
    return (
      <View style={{ borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: 20, alignItems: "center", gap: 4 }}>
        <Text style={text.strong}>No switches yet</Text>
        <Text style={[text.small, { textAlign: "center" }]}>Every time an agent changes accounts, or stays put because nothing has room, it shows up here.</Text>
      </View>
    );
  }
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
      {entries.map(({ agentId, agentTitle, row }, index) => {
        const trouble = row.outcome === "stayed" || row.reason === "exhausted";
        return (
          <View
            key={`${agentId}:${row.at}:${index}`}
            style={{ flexDirection: "row", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: colors.border }}
          >
            <View style={{ paddingTop: 2 }}>
              <Icon name={OUTCOME_ICON[row.outcome]} size={15} color={trouble ? colors.statusWarning : colors.foregroundMuted} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <Pressable accessibilityRole="button" disabled={!onOpenAgent} onPress={() => onOpenAgent?.(agentId)} style={{ flexShrink: 1 }}>
                  <Text style={[text.strong, { fontSize: 13 }]} numberOfLines={1}>
                    {agentTitle ?? "Untitled agent"}
                  </Text>
                </Pressable>
                <Text style={[text.small, { fontSize: 11, fontVariant: ["tabular-nums"] }]}>{formatAge(row.at)}</Text>
              </View>
              {row.from && row.to && row.from !== row.to ? (
                <Text style={[text.small, { color: colors.foreground }]} numberOfLines={1}>
                  {row.from} → {row.to}
                </Text>
              ) : null}
              <Text style={text.small}>{describeRow(row)}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
