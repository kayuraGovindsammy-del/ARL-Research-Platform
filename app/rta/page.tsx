import { RTAView } from "@/components/rta/RTAView";
import { TelemetryProvider } from "@/lib/telemetry-store";

export const metadata = {
  title: "RTA — Radio Telescope Array · ARL Control",
};

export default function RtaPage() {
  return (
    <TelemetryProvider service="RTA">
      <RTAView />
    </TelemetryProvider>
  );
}
