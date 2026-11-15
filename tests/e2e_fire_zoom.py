"""Render the actual fire overlay across overview/detail zooms without remote data."""
import asyncio
import base64
import json
from pathlib import Path

from playwright.async_api import async_playwright


async def main():
    source = Path(__file__).resolve().parents[1] / 'web/fire-overlay.js'
    module = 'data:text/javascript;base64,' + base64.b64encode(source.read_bytes()).decode()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 600, 'height': 500})
        await page.set_content('<div id="pane"></div>')
        result = await page.evaluate('''async module => {
            const { createFireOverlay } = await import(module);
            let zoom = 6, popup = '', labels = [];
            const handlers = {};
            const project = ([lat,lon], z) => {
                const s = 256 * 2 ** z, sin = Math.sin(lat*Math.PI/180);
                return {x:(lon+180)/360*s, y:(.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*s};
            };
            const map = {
                project, getZoom:()=>zoom, getZoomScale:(a,b)=>2**(a-b),
                getPane:()=>document.getElementById('pane'), getSize:()=>({x:600,y:500}),
                getPixelBounds:()=>{const c=project([40.7,-74],zoom);return {min:{x:c.x-300,y:c.y-250}}},
                containerPointToLayerPoint:([x,y])=>({x,y}),
                on:(events, fn)=>events.split(' ').forEach(name=>(handlers[name]??=[]).push(fn)),
            };
            window.L = {
                DomUtil:{create:(tag,cls,parent)=>{const n=document.createElement(tag);n.className=cls;parent.append(n);return n},setPosition:()=>{}},
                popup:()=>({setLatLng(){return this},setContent(n){popup=n.textContent;return this},openOn(){return this}}),
            };
            const original = CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText = function(text,...args){labels.push(text);return original.call(this,text,...args)};
            const draw = createFireOverlay(map,()=>['Aqua'],new Intl.NumberFormat('ru'),()=>false,()=>true);
            const grouped = [[-74,40.7,0,150],[-74,40.7,0,80]];
            const canvas = document.querySelector('.fire-canvas');
            const checks=[];
            const visible = () => !canvas.hidden && canvas.getContext('2d').getImageData(0,0,600,500).data.some((v,i)=>i%4===3&&v>0);
            const check = (name,pass)=>checks.push({name,pass});
            zoom=3;
            draw(grouped,'points',true,true);
            check('World overview keeps the original small markers without numeric bubbles',visible()&&labels.length===0);
            zoom=6;
            draw(grouped,'points',true,true);
            check('Overview is visible', visible());
            check('Regional overview also avoids numeric bubbles',labels.length===0);
            handlers.click[0]({containerPoint:{x:300,y:250},latlng:{lat:40.7,lng:-74}});
            check('A small overview marker still exposes its weighted count on click',popup.includes('230')&&popup.includes('групп'));
            zoom=7;labels=[];handlers.moveend.forEach(fn=>fn());
            check('Missing detail is not replaced with numeric groups or invented pixel locations',canvas.hidden&&labels.length===0);
            const exact=[[-74,40.7,0,1,'2025-04-12T12:00:00Z'],[-74,40.7,0,1,'2025-04-12T13:00:00Z']];
            draw(grouped,'points',true,true,exact);
            check('Ready detail replaces the group with visible pixels',visible());
            handlers.click[0]({containerPoint:{x:300,y:250},latlng:{lat:40.7,lng:-74}});
            check('Detailed popup uses actual observations',popup.includes('2')&&popup.includes('12:00:00'));
            zoom=6;labels=[];handlers.moveend.forEach(fn=>fn());
            check('Zooming back restores the original small-marker overview',visible()&&labels.length===0);
            zoom=7;draw(grouped,'heat',true,true);
            check('Heat mode also waits for actual detailed observations',canvas.hidden);
            draw(grouped,'points',true,true,[]);
            check('A completed empty detail result clears the previous overview',canvas.hidden);
            draw(grouped,'points',false,true);
            check('Turning the layer off still hides it',canvas.hidden);
            return checks;
        }''', module)
        await browser.close()
    for check in result:
        print(('PASS ' if check['pass'] else 'FAIL ') + check['name'])
    print(json.dumps({'passed':sum(c['pass'] for c in result),'checks':len(result)}))
    assert all(c['pass'] for c in result)


if __name__ == '__main__':
    asyncio.run(main())
