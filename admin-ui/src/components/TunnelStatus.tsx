/**
 * Tunnel connection status indicator.
 *
 * Shows a chip with a colored dot indicating whether the cloudflared
 * tunnel is connected. Since the admin UI is served through the tunnel,
 * connectivity is inferred from whether API polling succeeds.
 */

import Chip from "@mui/material/Chip";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import { useServiceStore } from "../stores/useServiceStore";

export function TunnelStatus() {
  const connected = useServiceStore((s) => s.connected);

  return (
    <Chip
      icon={
        <FiberManualRecordIcon
          sx={{
            fontSize: 12,
            color: connected ? "success.main" : "error.main",
          }}
        />
      }
      label={connected ? "Connected" : "Disconnected"}
      variant="outlined"
      size="small"
      data-testid="tunnel-status"
      data-connected={connected}
      sx={{
        borderColor: connected ? "success.main" : "error.main",
        "& .MuiChip-label": {
          color: connected ? "success.main" : "error.main",
        },
      }}
    />
  );
}
