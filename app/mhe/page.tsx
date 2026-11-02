import { MHEView } from "@/components/mhe/MHEView";
import { TelemetryProvider } from "@/lib/telemetry-store";

export const metadata = {
  title: "MHE — Mars Habitation Experiment · ARL Control",
};

export default function MhePage() {
  return (
    <TelemetryProvider service="MHE">
      <MHEView />
    </TelemetryProvider>
  );
}
