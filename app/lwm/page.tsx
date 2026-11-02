import { LWMView } from "@/components/lwm/LWMView";
import { TelemetryProvider } from "@/lib/telemetry-store";

export const metadata = {
  title: "LWM — Local Weather Monitoring · ARL Control",
};

export default function LwmPage() {
  return (
    <TelemetryProvider service="LWM">
      <LWMView />
    </TelemetryProvider>
  );
}
