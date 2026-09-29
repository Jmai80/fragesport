import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://oyhbdwtwtjtskfzwysrc.supabase.co";
const SUPABASE_KEY = "sb_publishable_kiKGG5B390hjmaIMqi3GXA_H8Qb_vB_";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

