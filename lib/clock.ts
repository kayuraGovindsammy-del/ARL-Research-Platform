import { prisma } from "./prisma";

/**
 * The platform clock.
 *
 * The lab services publish on their own timeline, and the exam services run an
 * accelerated one that sits ahead of this workstation's clock. Everything the
 * console shows — sample times, alert timestamps, the replay cursor — is on
 * that timeline, so the stamps the platform writes itself (acknowledge,
 * resolve, audit) are taken from it as well: the wall clock, or the newest
 * sample we hold, whichever is later.
 *
 * Mixing the two clocks is not cosmetic. A resolution stamped with the wall
 * clock would land *before* the raise it belongs to, and a replay of that
 * moment would show an alert that had already been cleared as still live.
 */
export async function platformNow(): Promise<Date> {
  const wall = new Date();
  try {
    const newest = await prisma.telemetry.findFirst({
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });
    if (!newest) return wall;
    const newestAt = newest.timestamp instanceof Date ? newest.timestamp : new Date(newest.timestamp);
    if (Number.isNaN(newestAt.getTime()) || newestAt.getTime() <= wall.getTime()) return wall;
    return newestAt;
  } catch {
    return wall;
  }
}
