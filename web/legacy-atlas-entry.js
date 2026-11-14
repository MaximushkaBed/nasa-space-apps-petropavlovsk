const url=new URL(location.href);url.pathname=url.pathname.replace(/atlas\.html$/,'');url.searchParams.set('view',url.hash==='#kishkenekol-case'?'cases':'atlas');location.replace(url.href);
