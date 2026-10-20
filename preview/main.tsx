import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { AccountsSurface } from "../client/accounts-surface";
import { createStore } from "../client/store";
import { PreviewColors } from "./mocks/colors";
import { StateViewSchema } from "../shared/model";
import { sample } from "./sample";

const params = new URLSearchParams(location.search);
const width = Number(params.get("w") ?? 1100);
const light = params.get("theme") === "light";

const colors = light
  ? { surface0: "#ffffff", surface1: "#f7f7f8", surface2: "#efeff1", border: "rgba(0,0,0,0.09)", foreground: "#18181b", foregroundMuted: "#71717a", accent: "#3b5bdb", accentForeground: "#ffffff", statusSuccess: "#2f9e44", statusWarning: "#e8890c", statusDanger: "#e03131" }
  : { surface0: "#0e0e10", surface1: "#17171a", surface2: "#202024", border: "rgba(255,255,255,0.08)", foreground: "#ececef", foregroundMuted: "#8c8c94", accent: "#7c93ff", accentForeground: "#0e0e10", statusSuccess: "#51cf66", statusWarning: "#fcc419", statusDanger: "#ff6b6b" };

const client = { rpc: async (contract: { name: string }) => (contract.name === "paseo-accounts.state" ? StateViewSchema.parse(structuredClone(sample)) : { ok: true, reopened: [], deferred: [], failed: [], continuedIn: null }) };
const store = createStore(client as never);
store.start();

document.body.style.margin = "0";
document.body.style.background = colors.surface0;
createRoot(document.getElementById("root")!).render(
  <PreviewColors.Provider value={colors}>
    <View style={{ width, height: "100vh" as never, borderRightWidth: 1, borderRightColor: colors.border }}>
      <AccountsSurface
        theme={{ colors } as never}
        layout={{ compact: width < 600, platform: "web" }}
        host={{ id: "my-mac", label: "my-mac" } as never}
        store={store}
        navigation={{ openAgent: (input: unknown) => console.log("open agent", input), openWorkspace: () => undefined }}
        {...({} as never)}
      />
    </View>
  </PreviewColors.Provider>,
);
