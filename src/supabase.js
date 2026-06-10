
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wowhjuzkglgseqwznxpw.supabase.co';

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indvd2hqdXprZ2xnc2Vxd3pueHB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MzA0NjcsImV4cCI6MjA5NjUwNjQ2N30.1DxAJkuOgp-D95YqMZ9vr3GwNzUdEPvOdSf3ukpnlCk';

const supabase = createClient(SUPABASE_URL, ANON_KEY);

module.exports = { supabase, ANON_KEY, SUPABASE_URL };

