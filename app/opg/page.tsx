import { OPGView } from "@/components/opg/OPGView";
import { TelemetryProvider } from "@/lib/telemetry-store";

export const metadata = {
  title: "OPG — On-Demand Power Generation · ARL Control",
};

export default function OpgPage() {
  return (
    <TelemetryProvider service="OPG">
      <OPGView />
    </TelemetryProvider>
  );
}
