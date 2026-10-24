// The 6-claim wave: six delegate verdicts while four workers run (nothing is refused). Same fixture
// and judge as wait_wave_starvation; see there.
import { wave } from "./wait_wave_starvation.ts";

export default wave(6, "wait_wave_six");
