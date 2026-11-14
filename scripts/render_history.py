"""Render the completed FIRMS history as an offline interactive report."""

import argparse
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = r'''<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>История тепловых аномалий СКО — NASA FIRMS</title>
<style>
:root{color-scheme:light;--ink:#182823;--muted:#66756d;--line:#dce3dc;--accent:#256348;--pale:#edf3ec;--paper:#fafbf8}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:44px 28px}h1{font-size:32px;line-height:1.18;margin:12px 0 14px;max-width:800px;font-weight:650}h2{font-size:19px;margin:0 0 8px}p{margin:8px 0}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent)}.muted,small{color:var(--muted)}.intro{max-width:850px}.stats{display:flex;flex-wrap:wrap;gap:38px;border-block:1px solid var(--line);padding:22px 0;margin:26px 0}.stat strong{display:block;font-size:25px}.stat span{font-size:12px;color:var(--muted)}.toolbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:28px 0 16px}select{font:inherit;color:var(--ink);border:1px solid var(--line);background:white;padding:9px 12px;border-radius:4px}.badge{font-size:12px;padding:4px 9px;background:var(--pale);color:var(--accent)}section{margin:28px 0}svg{width:100%;height:auto;display:block}svg text{font-family:system-ui,sans-serif;fill:var(--muted);font-size:12px}.plot{background:white;border:1px solid var(--line);padding:20px 18px}.caption{font-size:12px;color:var(--muted);margin-top:12px}.calendar{overflow:auto}.grid{display:grid;grid-template-columns:58px repeat(12,minmax(45px,1fr));gap:5px;min-width:700px}.cell{border:0;min-height:27px;font:12px system-ui;color:var(--ink);background:var(--pale);padding:6px 2px;text-align:center}.cell:hover{outline:2px solid var(--accent);outline-offset:0}.label{font-size:12px;color:var(--muted);align-self:center}.missing{background:#f0f1ee;color:#9ca59c}.coverage{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:22px}.coverage article{border-top:2px solid var(--line);padding-top:10px}.coverage strong{font-size:14px}.note{border-left:3px solid var(--accent);padding:4px 16px;margin:24px 0}.detail{min-height:56px;padding:12px 0;font-size:13px}a{color:var(--accent)}footer{border-top:1px solid var(--line);padding-top:16px;font-size:12px;color:var(--muted)}@media(max-width:600px){main{padding:24px 16px}h1{font-size:25px}.plot{padding:15px 6px}.stats{gap:20px}}
</style>
<main>
<div class="eyebrow">NASA Space Apps · Petropavlovsk · NASA FIRMS</div>
<h1>СКО: история спутниковых<br>тепловых аномалий</h1>
<div class="intro"><p id="period"></p><p class="muted">MODIS на Terra и Aqua; VIIRS на Suomi-NPP, NOAA-20 и NOAA-21. Центры детекций отфильтрованы по полигону Северо-Казахстанской области.</p></div>
<div class="stats"><div class="stat"><strong id="total"></strong><span>детекций, все платформы</span></div><div class="stat"><strong>5 платформ</strong><span>четыре отдельных ряда сенсоров</span></div><div class="stat"><strong id="jobcount"></strong><span>успешных частей загрузки</span></div><div class="stat"><strong>SP → NRT</strong><span>архив и свежая часть без перекрытия дат</span></div></div>
<div class="note">Это <strong>исходная история наблюдений</strong>. Детекция — спутниковое обнаружение тепловой аномалии, а не отдельный пожар. Ряды ещё не гармонизированы; их сумма не является сопоставимым показателем пожарной активности за 26 лет.</div>
<div class="toolbar"><label for="family">Ряд наблюдений</label><select id="family"><option value="MODIS">MODIS · Terra + Aqua</option><option value="VIIRS_SNPP">VIIRS · Suomi-NPP</option><option value="VIIRS_NOAA20">VIIRS · NOAA-20</option><option value="VIIRS_NOAA21">VIIRS · NOAA-21</option></select><span class="badge">Исходные детекции · UTC</span></div>
<section class="plot"><h2 id="charttitle"></h2><svg id="yearplot" viewBox="0 0 1080 310" role="img" aria-label="Спутниковые детекции по годам"></svg><div class="caption">Ось X — год UTC, ось Y — детекции, шт. Зелёный: стандартная обработка SP; серый: предварительная NRT. Звёздочкой отмечены неполные календарные годы. Источник: NASA FIRMS; период указан в заголовке.</div></section>
<section><h2>Календарь обнаружений по месяцам</h2><p class="muted">Нажмите месяц для состава SP/NRT и статуса выгрузки. Цвет: log(1 + число детекций). «—» означает отсутствие доступной выгрузки для этого периода.</p><div id="detail" class="detail"></div><div class="calendar"><div id="calendar" class="grid"></div></div><p class="caption">Успешный запрос с нулём детекций не подтверждает отсутствие пожаров: покрытие, облачность и пригодность наблюдения отдельно не проверены.</p></section>
<section><h2>Доступность источников</h2><div id="coverage" class="coverage"></div></section>
<section class="note"><strong>Версии и ограничения.</strong><p>Сохранены исходные версии коллекций, уверенность, спутник и тип аномалии. В данных есть и промышленные тепловые источники; поле type=0 сохранено отдельно в сводке, его надёжность зависит от версии. Последние сутки, месяц и год могут быть неполными. Окончание доступного ряда каждой платформы указано выше.</p><p>Граница области — geoBoundaries, референсный год 2017. Коэффициенты калибровки из исследования Оксаны здесь не применены: нужна проверка их переноса на версии данных полного архива.</p></section>
<footer><p>Источники: <a href="https://firms.modaps.eosdis.nasa.gov/download/">NASA FIRMS / NASA LANCE / ESDIS</a> · <a href="https://firms.modaps.eosdis.nasa.gov/api/data_availability/">Доступность API</a> · <a href="https://www.geoboundaries.org/">geoBoundaries / OpenStreetMap, ODbL</a></p><p><a href="sko-monthly.csv" download>Месячная сводка CSV</a> · <a href="sko-yearly.csv" download>Годовая сводка CSV</a> · <a href="sko-history-summary.json" download>Данные сводки JSON</a> · <a href="../docs/sko-validation/README.md">Исследование гармонизации СКО</a></p><p id="stamp"></p></footer>
</main>
<script id="dataset" type="application/json">__DATA__</script>
<script>
const D=JSON.parse(document.getElementById('dataset').textContent), labels={MODIS:'MODIS · Terra + Aqua',VIIRS_SNPP:'VIIRS · Suomi-NPP',VIIRS_NOAA20:'VIIRS · NOAA-20',VIIRS_NOAA21:'VIIRS · NOAA-21'},nf=new Intl.NumberFormat('ru-RU');
document.getElementById('period').textContent=D.requested_start+' — '+D.requested_end+' · даты наблюдений в UTC';
document.getElementById('total').textContent=nf.format(Object.values(D.totals_by_source).reduce((a,b)=>a+b,0));
document.getElementById('jobcount').textContent=nf.format(D.completed_jobs);
document.getElementById('stamp').textContent='Сводка построена '+D.created_at+'. Полный реестр загрузки и исходные CSV хранятся локально в data/raw/firms/sko/history/.';
for(const [family,label] of Object.entries(labels)){const a=document.createElement('article'),s=D.availability[family+'_SP'],n=D.availability[family+'_NRT'];a.innerHTML='<strong>'+label+'</strong>';for(const [kind,r] of [['SP',s],['NRT',n]])if(r){const p=document.createElement('p');p.className='caption';p.textContent=kind+': '+r.min_date+' — '+r.max_date;a.appendChild(p)}document.getElementById('coverage').appendChild(a)}
function svgNode(tag,attrs,text){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n}
function draw(){const family=document.getElementById('family').value,years=D.years.filter(x=>x.family===family),months=D.months.filter(x=>x.family===family),svg=document.getElementById('yearplot');svg.replaceChildren();document.getElementById('charttitle').textContent=labels[family]+': число детекций по годам';const max=Math.max(1,...years.map(x=>x.detections)),left=70,top=20,w=980,h=230,step=w/years.length,bw=Math.max(3,step*.68);for(let i=0;i<=4;i++){const y=top+h-i*h/4;svg.appendChild(svgNode('line',{x1:left,y1:y,x2:left+w,y2:y,stroke:'#e2e7e0'}));svg.appendChild(svgNode('text',{x:left-10,y:y+4,'text-anchor':'end'},nf.format(Math.round(max*i/4))))}svg.appendChild(svgNode('text',{x:15,y:18},'шт.'));svg.appendChild(svgNode('text',{x:left+w,y:300,'text-anchor':'end'},'Год (UTC)'));years.forEach((r,i)=>{const x=left+i*step+(step-bw)/2,standard=r.standard/max*h,nrt=r.near_real_time/max*h;for(const [val,height,color,y]of[[r.standard,standard,'#256348',top+h-standard],[r.near_real_time,nrt,'#8b9990',top+h-standard-nrt]]){if(val>0){const bar=svgNode('rect',{x,y,width:bw,height:Math.max(.7,height),fill:color});bar.appendChild(svgNode('title',{},r.year+': '+nf.format(r.detections)+' детекций; SP '+r.standard+', NRT '+r.near_real_time+'; дней выгрузки '+r.query_days));svg.appendChild(bar)}}if(years.length<15||i%2===0||i===years.length-1)svg.appendChild(svgNode('text',{x:x+bw/2,y:270,'text-anchor':'middle'},r.year+(r.partial_year?'*':'')))});
const grid=document.getElementById('calendar');grid.replaceChildren();const blank=document.createElement('span');grid.appendChild(blank);for(const name of ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек']){const s=document.createElement('span');s.className='label';s.style.textAlign='center';s.textContent=name;grid.appendChild(s)}const index=new Map(months.map(r=>[r.month,r])),peak=Math.max(1,...months.map(r=>r.detections));for(const year of years){const heading=document.createElement('span');heading.className='label';heading.textContent=year.year;grid.appendChild(heading);for(let m=1;m<=12;m++){const key=year.year+'-'+String(m).padStart(2,'0'),r=index.get(key),cell=document.createElement(r?'button':'span');cell.className='cell'+(r?'':' missing');cell.textContent=r?nf.format(r.detections):'—';if(r){const alpha=.08+.85*Math.log1p(r.detections)/Math.log1p(peak);cell.style.background='rgba(37,99,72,'+alpha+')';cell.style.color=alpha>.5?'white':'#182823';cell.title=key+': '+r.detections+' детекций';cell.onclick=()=>{document.getElementById('detail').textContent=labels[family]+' · '+key+': '+nf.format(r.detections)+' детекций; SP '+nf.format(r.standard)+', NRT '+nf.format(r.near_real_time)+'. Запрошено '+r.query_days+' из '+r.calendar_days+' календарных дней'+(r.partial_month?' — неполный месяц.':'.')+' Покрытие наблюдений неизвестно.'}}grid.appendChild(cell)}}document.getElementById('detail').textContent=labels[family]+'. Выберите месяц для подробностей.'}
document.getElementById('family').addEventListener('change',draw);draw();
</script></html>'''


def render(source, output, plot=False):
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest["status"] != "complete":
        raise ValueError("History download is incomplete; finish it before rendering a report.")
    summary = json.loads((source / "summary.json").read_text())
    summary["completed_jobs"] = len(manifest["completed"])
    output.mkdir(parents=True, exist_ok=True)
    data = json.dumps(summary, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    path = output / "sko-history.html"
    path.write_text(TEMPLATE.replace("__DATA__", data), encoding="utf-8")
    (output / "sko-history-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    # Use LF in tracked reports; retain the original cached/raw CSV bytes.
    for original, exported in (("monthly.csv", "sko-monthly.csv"), ("yearly.csv", "sko-yearly.csv")):
        (output / exported).write_text((source / original).read_text(encoding="utf-8"), encoding="utf-8")
    if plot:
        os.environ.setdefault("MPLCONFIGDIR", str(ROOT / "data/cache/matplotlib"))
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.ticker import MaxNLocator

        fig, axes = plt.subplots(2, 2, figsize=(13, 8.5), layout="constrained")
        names = {"MODIS": "MODIS / Terra + Aqua", "VIIRS_SNPP": "VIIRS / Suomi-NPP",
                 "VIIRS_NOAA20": "VIIRS / NOAA-20", "VIIRS_NOAA21": "VIIRS / NOAA-21"}
        for ax, (family, name) in zip(axes.flat, names.items()):
            rows = [row for row in summary["years"] if row["family"] == family]
            years = [int(row["year"]) for row in rows]
            ax.bar(years, [row["standard"] for row in rows], color="#256348", label="SP archive")
            ax.bar(years, [row["near_real_time"] for row in rows], bottom=[row["standard"] for row in rows],
                   color="#8b9990", label="NRT provisional")
            ax.set(title=name, xlabel="Year (UTC)", ylabel="Thermal-anomaly detections")
            ax.xaxis.set_major_locator(MaxNLocator(nbins=6, integer=True))
            ax.grid(axis="y", alpha=.2)
            ax.set_axisbelow(True)
            ax.spines[["top", "right"]].set_visible(False)
            ax.legend(frameon=False, fontsize=8)
        fig.suptitle("North Kazakhstan Region: raw MODIS and VIIRS detection history\n"
                     + summary["requested_start"] + " to " + summary["requested_end"], fontsize=14)
        fig.supxlabel("Source: NASA FIRMS / LANCE / ESDIS. Sensor series are not harmonized.\n"
                      "First/last years and satellite start years can be partial; observation coverage is unknown.", fontsize=9)
        fig.savefig(output / "sko-history.png", dpi=160)
        plt.close(fig)
    print(f"Report saved to {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "data/raw/firms/sko/history")
    parser.add_argument("--output", type=Path, default=ROOT / "reports")
    parser.add_argument("--plot", action="store_true", help="Also export PNG; requires matplotlib")
    args = parser.parse_args()
    render(args.source, args.output, args.plot)


if __name__ == "__main__":
    main()
