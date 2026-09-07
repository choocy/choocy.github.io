window.MEMENTO_CONFIG = {
  env: new URLSearchParams(location.search).get('env') === 'dev' || new URLSearchParams(location.search).get('env') === 'development'
    ? 'development'
    : location.hostname === 'choocy.app' || location.hostname === 'www.choocy.app'
    ? 'production'
    : 'development',
  development: {
    project: 'memento-dev',
    supabaseUrl: 'https://omtdedqgtheuutxqzoij.supabase.co',
    supabaseAnonKey: 'sb_publishable_k19PA2vgSv5VxLircw_5Vw_sAHzzCUm',
    originalsBucket: 'memento-originals',
  },
  production: {
    project: 'memento-prd',
    supabaseUrl: 'https://lnxlxdgozvqodwmtuuhr.supabase.co',
    supabaseAnonKey: 'sb_publishable_nsJPpnP8TDCFqd5T-*mWaQ_qM00V21*',
    originalsBucket: 'memento-originals',
  },
};
