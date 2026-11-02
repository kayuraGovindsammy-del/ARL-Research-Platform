import { OverviewView } from "@/components/OverviewView";
import { TelemetryProvider } from "@/lib/telemetry-store";

export const metadata = {
  title: "Overview · ARL Control",
};

export default function OverviewPage() {
  return (
    <TelemetryProvider service={null}>
      <OverviewView />
    </TelemetryProvider>
  );
}
