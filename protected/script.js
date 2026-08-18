(function() {
  'use strict';
  var $ = function(id) { return document.getElementById(id); };

  /* Перезапуск одноразовой CSS-анимации: снять класс → reflow → надеть класс */
  function retrig(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  var hiddenPanels = {};
  /* Плавное сворачивание/разворачивание панелей: scale+fade через .panel-hide,
     display:none — только по завершении перехода (transitionend + таймер-страховка) */
  window.closePanel = function(id) {
    var el = $(id);
    if (el) {
      hiddenPanels[id] = true;
      el.classList.add('panel-hide'); /* ящик уезжает за свой край (векторы в CSS) */
      el.setAttribute('aria-hidden', 'true');
      var done = function() {
        el.removeEventListener('transitionend', done);
        if (hiddenPanels[id]) el.style.display = 'none';
        el.classList.remove('panel-hide');
      };
      el.addEventListener('transitionend', done);
      setTimeout(done, 560); /* страховка: чуть больше --dur-drawer (500мс) выезда */
    }
    var rb = $('restore-' + id); if (rb) { rb.style.display = 'block'; rb.setAttribute('aria-expanded', 'false'); }
  };
  window.restorePanel = function(id) {
    var el = $(id);
    if (el) {
      var flexPanels = { ctrl: 1, tl: 1 };
      hiddenPanels[id] = false;
      el.classList.add('panel-hide'); /* стартовая позиция — за краем */
      el.style.display = flexPanels[id] ? 'flex' : 'block';
      el.setAttribute('aria-hidden', 'false');
      void el.offsetWidth; /* reflow — фиксируем позицию «за краем», затем плавный въезд */
      el.classList.remove('panel-hide');
    }
    var rb = $('restore-' + id); if (rb) { rb.style.display = 'none'; rb.setAttribute('aria-expanded', 'true'); }
  };

  var SRC = 'https://rainradar.ru/composite', FZ = 5, MDBZ = 5, DELAY = 600, STEP = 600;

  /* ═══ Источник радара dBZ: 'nowcast' (ДМРЛ, основной) | 'rainradar' (запасной).
     Отдельный localStorage-ключ radarSource (mapView не трогаем).
     nowcast-тайлы приходят УЖЕ ЦВЕТНЫМИ в палитре, совпадающей с BUILTIN_RADAR
     (проверено по пикселям) → показываем как есть; кастомные палитры пользователя —
     реколоризация через procQueue (обратное сопоставление цвет→dBZ). ═══ */
  var radarSource = 'nowcast';
  try { var rsv = localStorage.getItem('radarSource'); if (rsv === 'rainradar' || rsv === 'nowcast') radarSource = rsv; } catch (e) {}
  var radarSourceAuto = false; /* true = на rainradar ушли АВТОМАТИЧЕСКИ (из-за ошибок) */
  /* Данные nowcast для отражаемости: ДМРЛ-станции РФ либо композит FMI (Европа).
     Переключатель в легенде: покрытие у них разное, пусть выбирает пользователь. */
  var RADAR_NC_LAYERS = [
    { id: 'bufr_dbz1', label: 'ДМРЛ РФ (1 км)' },
    { id: 'fmi_open_composite_dbz', label: 'FMI композит (Европа)' }
  ];
  var radarNcIdx = 0;
  try { var rnl = localStorage.getItem('radarNcLayer'); var rni = RADAR_NC_LAYERS.findIndex(function(l) { return l.id === rnl; }); if (rni >= 0) radarNcIdx = rni; } catch (e) {}
  /* ─── ОЯ BUFR: ВСЕ станции явлений nowcast, показываются одновременно (география
     станций не пересекается → комбинированный слой корректен).
     gimet_phenomena ИСКЛЮЧЁН: в GetCapabilities у него нет Extent/BBox (mapserver
     пишет WARNING «could not be established»), тайлы пустые по всей РФ — мёртвый слой. */
  var WX_NC_LAYERS = [
    { id: 'bufr_phenomena', label: 'Москва' },
    { id: 'bufr_novosib_phenomena', label: 'Новосибирск' },
    { id: 'bufr_vlad_phenomena', label: 'Владивосток' }
  ];
  /* Фактическая палитра источника: [код BUFR, цвет, название явления].
     Цвета сняты с GetLegendGraphic bufr_phenomena и сверены попиксельно через
     GetFeatureInfo (var value=N в ответе). Названия — из скрипта конвертации nowcast;
     у кодов 10–12 в источнике метки «гроза (R…)» — R это вероятность грозы. */
  var WX_NC_PALETTE = [
    [0,  'rgb(202,202,202)', 'нет эха (зона обзора)'],
    [1,  'rgb(155,168,175)', 'облачность среднего яруса'],
    [2,  'rgb(160,196,253)', 'слоистообразная облачность'],
    [3,  'rgb(68,253,145)',  'осадки слабые'],
    [4,  'rgb(0,192,88)',    'осадки умеренные'],
    [5,  'rgb(0,151,0)',     'осадки сильные'],
    [6,  'rgb(253,253,126)', 'кучевая облачность'],
    [7,  'rgb(61,135,253)',  'ливень слабый'],
    [8,  'rgb(0,55,253)',    'ливень умеренный'],
    [9,  'rgb(0,0,115)',     'ливень сильный'],
    [10, 'rgb(253,168,125)', 'гроза (вероятн. 30–70%)'],
    [11, 'rgb(253,84,125)',  'гроза (вероятн. 70–90%)'],
    [12, 'rgb(253,0,0)',     'гроза (вероятн. >90%)'],
    [13, 'rgb(202,101,0)',   'град слабый'],
    [14, 'rgb(135,66,0)',    'град умеренный'],
    [15, 'rgb(94,0,0)',      'град сильный'],
    [16, 'rgb(253,168,253)', 'шквал слабый'],
    [17, 'rgb(253,84,253)',  'шквал умеренный'],
    [18, 'rgb(198,0,198)',   'шквал сильный'],
    [19, 'rgb(62,62,94)',    'смерч']
  ];
  /* Код явления → название (для попапа GetFeatureInfo) */
  var WX_NC_CODES = {};
  WX_NC_PALETTE.forEach(function(p) { WX_NC_CODES[p[0]] = p[2]; });
  WX_NC_CODES[255] = 'нет информации';
  /* Числовые RGB палитры ОЯ — для указателя/прицела (сопоставление цвета пикселя тайла) */
  var WX_NC_RGB = WX_NC_PALETTE.map(function(p) { var m = p[1].match(/\d+/g); return [+m[0], +m[1], +m[2]]; });
  /* ─── Палитра доплера bufr_vel*: [R,G,B, скорость м/с|null, подпись].
     Цвета сняты с GetLegendGraphic bufr_vel1 (20 плашек); 9 из них откалиброваны
     живым GetFeatureInfo (value → v = 63.5·(−1+(value−1)·2/254)), остальные —
     интерполяция по порядку легенды. Таблица ОЦЕНОЧНАЯ (шаг плашки ~3–5 м/с),
     точное значение в точке даёт клик (GetFeatureInfo). null = нет эха. ─── */
  var DOP_NC_RGB = [
    [202, 202, 202, null, 'нет эха (зона обзора)'],
    [84,  178, 205, -40, '≈−40 м/с (к радару)'],
    [69,  133, 156, -30, '≈−30 м/с (к радару)'],
    [32,  79,  31,  -24, '≈−24 м/с (к радару)'],
    [52,  125, 31,  -19, '≈−19 м/с (к радару)'],
    [0,   178, 0,   -15, '≈−15 м/с (к радару)'],
    [49,  215, 49,  -11, '≈−11 м/с (к радару)'],   /* калибровано: −11.0 */
    [78,  246, 72,  -8,  '≈−8 м/с (к радару)'],    /* калибровано: −8.0 */
    [153, 200, 169, -2,  '≈−2 м/с (к радару)'],    /* калибровано: −1.0 */
    [185, 250, 216, -0.5, '≈−0.5 м/с (слабо к радару)'],
    [253, 253, 253, 0,   '~0 м/с (поперёк луча)'],
    [252, 0,   252, 1,   '≈+1 м/с (от радара)'],   /* калибровано: +0.5 */
    [175, 0,   175, 4,   '≈+4 м/с (от радара)'],   /* калибровано: +5.0 */
    [123, 0,   123, 7,   '≈+7 м/с (от радара)'],   /* калибровано: +6.0 */
    [145, 0,   0,   10,  '≈+10 м/с (от радара)'],  /* калибровано: +10.5 */
    [178, 0,   0,   14,  '≈+14 м/с (от радара)'],
    [202, 0,   0,   18,  '≈+18 м/с (от радара)'],
    [235, 0,   0,   22,  '≈+22 м/с (от радара)'],
    [253, 58,  58,  28,  '≈+28 м/с (от радара)'],
    [253, 119, 109, 36,  '≈+36 м/с (от радара)']
  ];
  /* Экранная палитра радиальной скорости: дискретный шаг 5 м/с, −50…+50.
     Сине-оранжевая diverging-схема различима при нарушениях цветовосприятия;
     светлый нейтральный стоп подчёркивает нулевую изодопу. */
  var DOP_DISPLAY_PALETTE = [
    [-50, [24, 28, 67]], [-45, [28, 44, 92]], [-40, [31, 61, 116]],
    [-35, [35, 79, 138]], [-30, [40, 98, 156]], [-25, [52, 119, 171]],
    [-20, [72, 141, 184]], [-15, [99, 163, 196]], [-10, [132, 184, 206]],
    [-5, [171, 205, 215]], [0, [238, 236, 229]], [5, [226, 207, 192]],
    [10, [216, 177, 151]], [15, [205, 145, 111]], [20, [190, 112, 78]],
    [25, [172, 82, 58]], [30, [151, 57, 51]], [35, [128, 39, 48]],
    [40, [105, 27, 45]], [45, [85, 20, 42]], [50, [64, 15, 37]]
  ];

  /* Фактические цвета GetLegendGraphic слоя bufr_height, в порядке высотных
     классов. Раньше легенда вставлялась картинкой 74×290 без подписей — из-за
     этого шкала выглядела сломанной. Теперь подписи строятся клиентом. */
  var HEIGHT_DISPLAY_PALETTE = [
    [0, [5,252,162]], [1, [25,240,105]], [2, [25,189,126]], [3, [32,148,111]],
    [4, [35,112,98]], [5, [21,64,54]], [6, [0,202,233]], [7, [2,133,227]],
    [8, [2,52,205]], [9, [4,21,108]], [10, [209,179,29]], [11, [215,72,25]],
    [12, [215,25,15]], [13, [131,4,9]], [14, [65,166,2]], [15, [2,62,2]],
    [16, [159,15,71]], [17, [216,45,156]]
  ];

  var HISTORY_MINUTES = 190, MAX_HISTORY_SEC = HISTORY_MINUTES * 60;
  var BASE_RES_KM = 2;

  /* ─── Спутник EUMETSAT: сетка времени 15 мин, задержка публикации ~20 мин, история 12 ч ─── */
  var SAT_STEP = 900, SAT_DELAY = 1200, SAT_HISTORY_SEC = 12 * 3600;
  /* БЛОК A: спутник ВСЕГДА полупрозрачный — базовая карта видна сквозь тайлы.
     Вариант №1 (жёстко 50%): слайдер в sat-режиме заблокирован и показывает 50,
     значение радара запоминается и возвращается при выходе из sat. */
  var SAT_OPACITY = 0.5;              /* ДЕФОЛТ при входе в sat — дальше рулит слайдер */
  var radarOpacityMem = 100;          /* значение слайдера радара до входа в sat */
  var satOpacityMem = Math.round(SAT_OPACITY * 100); /* текущая прозрачность спутника (сессия+mapView) */
  /* Тёмная подложка на светлых темах: пользователь может отключить (localStorage) */
  var satBackdropOn = true;
  try { satBackdropOn = localStorage.getItem('satBackdrop') !== '0'; } catch (e) {}

  /* ─── Определение устройства: мобильный → меньше кэш, легче обработка, DPR-потолок ─── */
  var IS_MOBILE = matchMedia('(max-width: 768px)').matches || matchMedia('(pointer: coarse)').matches;
  /* ─── БЛОК C: режим анимаций. animPref: 'auto' (следовать prefers-reduced-motion),
     'on' (анимировать всегда), 'off' (никогда). Класс html.reduce-motion ставит
     ранний инлайн-скрипт в <head> (до отрисовки); здесь — live-переключение.
     REDUCE_MOTION остаётся переменной — все проверки в коде читают её в рантайме. */
  var ANIM_PREF = 'auto';
  try { var ap = localStorage.getItem('animPref'); if (ap === 'on' || ap === 'off' || ap === 'auto') ANIM_PREF = ap; } catch (e) {}
  var sysReducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  var REDUCE_MOTION = ANIM_PREF === 'off' || (ANIM_PREF === 'auto' && sysReducedMq.matches);
  function applyAnimPref() {
    REDUCE_MOTION = ANIM_PREF === 'off' || (ANIM_PREF === 'auto' && sysReducedMq.matches);
    document.documentElement.classList.toggle('reduce-motion', REDUCE_MOTION);
  }
  /* Смена системной настройки на лету (в режиме auto) */
  if (sysReducedMq.addEventListener) sysReducedMq.addEventListener('change', applyAnimPref);
  else if (sysReducedMq.addListener) sysReducedMq.addListener(applyAnimPref);
  var DPR = Math.min(window.devicePixelRatio || 1, 2); /* потолок 2: выше — только расход памяти */

  var BUILTIN_RADAR = [
    { v: 70, r: [113, 0, 0], l: '70 dBZ' },
    { v: 65, r: [168, 0, 254], l: '65 dBZ' },
    { v: 60, r: [244, 0, 244], l: '60 dBZ' },
    { v: 55, r: [0, 168, 0], l: '55 dBZ' },
    { v: 50, r: [73, 219, 0], l: '50 dBZ' },
    { v: 40, r: [254, 58, 54], l: '40 dBZ' },
    { v: 35, r: [254, 125, 0], l: '35 dBZ' },
    { v: 30, r: [254, 254, 0], l: '30 dBZ' },
    { v: 25, r: [0, 0, 125], l: '25 dBZ' },
    { v: 20, r: [0, 0, 205], l: '20 dBZ' },
    { v: 15, r: [0, 76, 254], l: '15 dBZ' },
    { v: 10, r: [0, 168, 254], l: '10 dBZ' },
    { v: 5, r: [83, 254, 56], l: '5 dBZ' }
  ];

  var BUILTIN_WX = [
    { v: 70, r: [43, 43, 43], l: 'Смерч' },
    { v: 65, r: [128, 60, 110], l: 'Шквал сильный' },
    { v: 59, r: [204, 117, 181], l: 'Шквал умеренный' },
    { v: 57, r: [253, 201, 239], l: 'Шквал слабый' },
    { v: 54, r: [77, 57, 35], l: 'Град сильный' },
    { v: 52, r: [112, 84, 51], l: 'Град умеренный' },
    { v: 50, r: [161, 123, 79], l: 'Град слабый' },
    { v: 48, r: [255, 61, 61], l: 'Гроза A+ (>90%)' },
    { v: 46, r: [220, 80, 80], l: 'Гроза A (71-90%)' },
    { v: 45, r: [242, 186, 156], l: 'Гроза B (30-70%)' },
    { v: 37, r: [15, 55, 107], l: 'Ливень сильный' },
    { v: 35, r: [37, 87, 152], l: 'Ливень умеренный' },
    { v: 30, r: [75, 149, 247], l: 'Ливень слабый' },
    { v: 28, r: [238, 240, 132], l: 'Осадки сильные' },
    { v: 24, r: [26, 97, 64], l: 'Осадки умеренные' },
    { v: 16, r: [53, 146, 103], l: 'Осадки слабые' },
    { v: 13, r: [88, 249, 174], l: 'Морось' },
    { v: 9, r: [129, 204, 223], l: 'Легкая морось' },
    { v: 6, r: [145, 145, 145], l: 'Облака' },
    { v: 5, r: [107, 107, 107], l: 'Нет явления' }
  ];

  var S = {
    ts: 0, px: 1, layer: 'radar', playing: false, timer: null, speedI: 0, speeds: [1, 2, 4],
    frameI: 0, frames: [], cache: new Map(), pending: new Set(), failed: new Set(),
    cacheMax: (IS_MOBILE ? 130 : 400), loadN: 0, manualTime: false, legendVis: true, smooth: false, smoothStrength: 1,
    fade: { active: false, start: 0, duration: 300, alpha: 1 },
    dbzVisible: true, /* показ слоя осадков (кнопка-«глаз») */
    pxLevels: [0.5, 1, 2, 4], pxIndex: 1,
    ruler: { active: false, points: [], markers: [], polyline: null, label: null, segmentLabels: [] }
  };
  S.px = S.pxLevels[S.pxIndex];
  var palettes = { radar: { list: [], activeIdx: 0 }, wx: { list: [], activeIdx: 0 }, sat: { byChannel: {} } };
  /* ─── Палитры спутника: по одной корзине на канал (palettes.sat.byChannel[chId] = {list, activeIdx}).
     Фасад .list/.activeIdx через геттеры указывает на канал, выбранный в модалке (satModalChId),
     поэтому ВЕСЬ существующий код модалки (список/создание/удаление/экспорт) работает без правок ─── */
  var satModalChId = 'ir108';
  Object.defineProperty(palettes.sat, 'list', {
    get: function() { return satBucket(satModalChId).list; },
    set: function(v) { satBucket(satModalChId).list = v; }
  });
  Object.defineProperty(palettes.sat, 'activeIdx', {
    get: function() { return satBucket(satModalChId).activeIdx; },
    set: function(v) { satBucket(satModalChId).activeIdx = v; }
  });
  /* Корзина палитр канала: создаётся лениво, всегда начинается со встроенных */
  function satBucket(chId) {
    var bc = palettes.sat.byChannel;
    if (!bc[chId]) {
      var ch = null;
      for (var i = 0; i < SAT_CHANNELS.length; i++) if (SAT_CHANNELS[i].id === chId) { ch = SAT_CHANNELS[i]; break; }
      var builtins = BUILTIN_SAT[chId];
      if (!builtins) {
        /* RGB-канал: палитра только для легенды (тайлы уже цветные, реколоризация не применяется) */
        var rows = (ch && ch.legend && ch.legend.rows) || [];
        var items = rows.map(function(r, j) { var c = hexToRgb(r[0]) || { r: 128, g: 128, b: 128 }; return { v: (rows.length - j) * 40, r: [c.r, c.g, c.b], l: r[1] }; });
        builtins = [{ name: 'Стандарт (цветной канал)', items: items, builtin: true, noRecolor: true, legendOnly: true }];
      }
      bc[chId] = { list: builtins.slice(), activeIdx: 0 };
    }
    return bc[chId];
  }
  /* Активная палитра канала, который сейчас на карте */
  function satActivePalette() {
    var b = satBucket(SAT_CHANNELS[satChIdx].id);
    if (b.activeIdx >= b.list.length) b.activeIdx = 0;
    return b.list[b.activeIdx] || null;
  }

  var eumetsatLayer = null;
  var satOldLayer = null;      /* предыдущий слой — снимается после загрузки нового (без «чёрной вспышки») */
  var satLoading = false;      /* индикация загрузки WMS-тайлов */
  var satErrToastTs = 0;       /* троттлинг тоста об ошибке */

  /* ─── Каналы EUMETSAT (WMS view.eumetsat.int, проверенные слои msg_fes:*).
     day:true — канал информативен только в светлое время суток.
     legend: grad — градиентная шкала, rows — дискретные строки ─── */
  var SAT_CHANNELS = [
    { id: 'ir108', gray: true, label: 'IR 10.8 (ИК)',        wms: 'msg_fes:ir108',            legend: { grad: ['#ffffff', '#999999', '#222222'], rows: [['#ffffff', 'Очень холодные вершины (грозы)'], ['#999999', 'Облака среднего яруса'], ['#333333', 'Тепло / земля / море']] } },
    { id: 'wv062', gray: true, label: 'WV 6.2 (водяной пар)', wms: 'msg_fes:wv062',           legend: { grad: ['#ffffff', '#888888', '#1a1a1a'], rows: [['#ffffff', 'Влажная верхняя тропосфера'], ['#333333', 'Сухой воздух']] } },
    { id: 'vis006', gray: true, label: 'VIS 0.6 (видимый)',    wms: 'msg_fes:vis006', day: true, legend: { rows: [['#ffffff', 'Яркие облака / снег'], ['#888888', 'Тонкая облачность'], ['#222222', 'Поверхность (день)']] } },
    { id: 'rgb_natural', label: 'Натуральные цвета',    wms: 'msg_fes:rgb_natural', day: true, legend: { rows: [['#f5f5f5', 'Водяные облака'], ['#7fd4e6', 'Лёд / снег (циан)'], ['#3d7a3d', 'Растительность']] } },
    { id: 'rgb_microphysics', label: 'Микрофизика облаков', wms: 'msg_fes:rgb_microphysics', legend: { rows: [['#d4553d', 'Мощные капельные облака'], ['#e6d44f', 'Тонкие перистые'], ['#4f66e6', 'Ледяные вершины']] } },
    { id: 'rgb_convection', label: 'Конвекция',         wms: 'msg_fes:rgb_convection', legend: { rows: [['#e6e64f', 'Сильная конвекция (жёлтое)'], ['#b34fe6', 'Развивающиеся ячейки'], ['#4f9ae6', 'Зрелые наковальни']] } },
    { id: 'rgb_fog',     label: 'Туман (ночь)',         wms: 'msg_fes:rgb_fog',         legend: { rows: [['#4fe67a', 'Туман / низкая облачность'], ['#e64f4f', 'Плотные облака'], ['#3d3d80', 'Ясно (ночь)']] } },
    { id: 'rgb_dust',    label: 'Пыль',                 wms: 'msg_fes:rgb_dust',        legend: { rows: [['#e654c8', 'Пыль (розовое)'], ['#c8a03c', 'Сухой воздух'], ['#5a78b4', 'Облака']] } },
    { id: 'rgb_airmass', label: 'Воздушные массы',      wms: 'msg_fes:rgb_airmass',     legend: { rows: [['#4fb4e6', 'Холодная ВМ (голубое)'], ['#4fe6b4', 'Тёплая ВМ (зелёное)'], ['#b44fe6', 'Стратосферное вторжение']] } },
    { id: 'cth', gray: true, label: 'Высота вершин облаков', wms: 'msg_fes:cth',            legend: { rows: [['#d4553d', 'Очень высокие (>12 км)'], ['#e6d44f', 'Средние (5–8 км)'], ['#4f66e6', 'Низкие (<3 км)']] } },
    { id: 'fire',        label: 'Пожары',               wms: 'msg_fes:fire',            legend: { rows: [['#ff3d3d', 'Активный очаг'], ['#ffb43d', 'Вероятный очаг']] } },
    { id: 'rdt',         label: 'Грозы (RDT)',          wms: 'msg_fes:rdt',             legend: { rows: [['#ff3d3d', 'Зрелая грозовая ячейка'], ['#ffb43d', 'Развивающаяся'], ['#ffe63d', 'Зарождающаяся']] } },
    { id: 'gii_kindex', gray: true, label: 'K-индекс',             wms: 'msg_fes:gii_kindex',      legend: { rows: [['#d4553d', 'K > 35 (высокая неустойчивость)'], ['#e6d44f', 'K 25–35 (умеренная)'], ['#4f66e6', 'K < 25 (стабильно)']] } },
    { id: 'gii_liftedindex', gray: true, label: 'Lifted Index',     wms: 'msg_fes:gii_liftedindex', legend: { rows: [['#d4553d', 'LI < −4 (сильная неустойчивость)'], ['#e6d44f', 'LI −4…0 (умеренная)'], ['#4f66e6', 'LI > 0 (стабильно)']] } }
  ];

  /* ─── БЛОК C: встроенные палитры спутника (порог = яркость пикселя 0–255, шкала «v и выше») ───
     noRecolor: показываем оригинальные тайлы (палитра — только легенда).
     Цвета согласованы с тёмной темой сайта — спокойные, не кислотные. */
  var BUILTIN_SAT = {
    ir108: [
      { name: 'Классический серый', builtin: true, noRecolor: true, items: [
        { v: 230, r: [255, 255, 255], l: 'Грозовые вершины (< −55°C)' },
        { v: 180, r: [214, 214, 218], l: 'Мощные облака (−40…−55°C)' },
        { v: 120, r: [150, 150, 156], l: 'Средний ярус (−15…−40°C)' },
        { v: 60,  r: [92, 92, 98],    l: 'Низкие облака (0…−15°C)' },
        { v: 0,   r: [42, 42, 46],    l: 'Земля / море (> 0°C)' }] },
      { name: 'Усиленный IR', builtin: true, items: [
        { v: 245, r: [236, 120, 220], l: 'Экстрем. холод (< −70°C)' },
        { v: 230, r: [178, 96, 226],  l: '−60…−70°C — овершуты' },
        { v: 215, r: [104, 88, 222],  l: '−50…−60°C — мощная конвекция' },
        { v: 200, r: [86, 140, 232],  l: '−40…−50°C' },
        { v: 185, r: [96, 196, 202],  l: '−30…−40°C' },
        { v: 168, r: [110, 188, 110], l: '−20…−30°C' },
        { v: 150, r: [214, 200, 108], l: '−10…−20°C' },
        { v: 130, r: [216, 148, 92],  l: '0…−10°C' },
        { v: 105, r: [186, 106, 92],  l: 'Тёплая облачность' },
        { v: 0,   r: [72, 72, 78],    l: 'Земля / море' }] }
    ],
    wv062: [
      { name: 'Водяной пар', builtin: true, items: [
        { v: 215, r: [240, 244, 248], l: 'Очень влажный верх тропосферы' },
        { v: 180, r: [170, 196, 220], l: 'Влажно' },
        { v: 145, r: [110, 144, 182], l: 'Умеренно' },
        { v: 110, r: [82, 100, 140],  l: 'Суховато' },
        { v: 70,  r: [96, 82, 90],    l: 'Сухой воздух' },
        { v: 0,   r: [64, 50, 52],    l: 'Очень сухо (просадка)' }] },
      { name: 'WV усиленный', builtin: true, items: [
        { v: 220, r: [120, 220, 210], l: 'Насыщенные влажные зоны' },
        { v: 185, r: [96, 170, 224],  l: 'Влажные языки' },
        { v: 150, r: [96, 110, 170],  l: 'Фон' },
        { v: 110, r: [140, 100, 110], l: 'Сухие вторжения' },
        { v: 0,   r: [180, 120, 80],  l: 'Экстремально сухо' }] }
    ],
    vis006: [
      { name: 'VIS контраст', builtin: true, items: [
        { v: 220, r: [255, 255, 255], l: 'Яркие облака / снег' },
        { v: 170, r: [206, 208, 212], l: 'Плотная облачность' },
        { v: 120, r: [150, 152, 158], l: 'Тонкая облачность' },
        { v: 70,  r: [96, 98, 104],   l: 'Дымка' },
        { v: 0,   r: [40, 42, 46],    l: 'Поверхность' }] }
    ],
    cth: [
      { name: 'Высота вершин', builtin: true, items: [
        { v: 220, r: [214, 84, 78],   l: '> 12 км — экстремально высокие' },
        { v: 180, r: [224, 156, 88],  l: '10–12 км' },
        { v: 140, r: [222, 208, 110], l: '7–10 км' },
        { v: 100, r: [116, 190, 120], l: '5–7 км' },
        { v: 60,  r: [92, 148, 216],  l: '3–5 км' },
        { v: 0,   r: [80, 96, 160],   l: '< 3 км — низкие' }] }
    ],
    gii_kindex: [
      { name: 'Неустойчивость (K)', builtin: true, items: [
        { v: 200, r: [214, 84, 78],   l: 'K > 35 — высокая' },
        { v: 140, r: [224, 170, 92],  l: 'K 30–35 — значительная' },
        { v: 90,  r: [222, 208, 110], l: 'K 25–30 — умеренная' },
        { v: 0,   r: [104, 172, 116], l: 'K < 25 — стабильно' }] }
    ],
    gii_liftedindex: [
      { name: 'Неустойчивость (LI)', builtin: true, items: [
        { v: 200, r: [214, 84, 78],   l: 'LI < −6 — экстремальная' },
        { v: 140, r: [224, 170, 92],  l: 'LI −4…−6 — сильная' },
        { v: 90,  r: [222, 208, 110], l: 'LI 0…−4 — умеренная' },
        { v: 0,   r: [104, 172, 116], l: 'LI > 0 — стабильно' }] }
    ]
  };
  var satChIdx = 0;
  try { var savedCh = localStorage.getItem('satChannel'); var fi = SAT_CHANNELS.findIndex(function(c) { return c.id === savedCh; }); if (fi >= 0) satChIdx = fi; } catch (e) {}
  /* ─── Грозовые продукты (раздел «Спутник», отдельные от каналов EUMETSAT).
     CIN РЕАЛИЗОВАН: Open-Meteo отдаёт его как hourly=convective_inhibition
     (проверено живьём: HTTP 200, Дж/кг; параметр «cin» действительно даёт 400 —
     другое имя переменной). SUPERCELL — ЧЕСТНАЯ ОЦЕНКА из CAPE + сдвига ветра
     (не SCP NOAA). COMPOSITE — WMS-композиты отражаемости через /api/nowcastProxy. */
  /* Высота ВГО технически использует тот же WMS-контур, что и спутниковые
     продукты, но в интерфейсе это самостоятельный верхнеуровневый слой.
     CAPE/CIN/SCP/COMPOSITE удалены: они больше не смешиваются с каналами спутника. */
  var SAT_PRODUCTS = [
    { id: 'height', label: 'Высота ВГО', kind: 'wms' }
  ];
  /* Все станции ВГО одним LAYERS через запятую — как в демо источника 4x4 */
  var HEIGHT_NC_LAYERS = 'bufr_height,bufr_novosib_height,bufr_vlad_height';
  var satProduct = null; /* null = обычный канал EUMETSAT; height включается через меню «Слои» */
  try { localStorage.removeItem('satProduct'); } catch (e) {}
  function prodActive() { return S.layer === 'sat' && !!satProduct; }
  function prodDef() { for (var i = 0; i < SAT_PRODUCTS.length; i++) if (SAT_PRODUCTS[i].id === satProduct) return SAT_PRODUCTS[i]; return null; }
  /* Регион композита: FMI (Европа) или BALTRAD (ДМРЛ РФ) */
  var COMPOSITE_REGIONS = [
    { id: 'fmi_open_composite_dbz', label: 'FMI (Европа)' },
    { id: 'baltrad_dbz', label: 'ДМРЛ РФ' }
  ];
  var compositeRegionIdx = 0;
  try { var crs2 = localStorage.getItem('prodCompositeRegion'); var cri = COMPOSITE_REGIONS.findIndex(function(r) { return r.id === crs2; }); if (cri >= 0) compositeRegionIdx = cri; } catch (e) {}

  function satIso(ts) { return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  /* ─── БЛОК A: устойчивая загрузка WMS ───
     Эндпоинты: [0] — основной. Зеркало добавлять сюда строкой (например, региональный прокси);
     при массовых ошибках клиент сам переключится на следующий. */
  /* ─── БЛОК A: устойчивая загрузка WMS ───
     [0] — прокси через свой домен (Vercel вне РФ + edge-кэш + без CORS),
     [1] — прямой EUMETSAT как fallback (реколоризация на нём может отключиться
     без CORS — recolorSatTile уже деградирует через catch). */
  var SAT_WMS_ENDPOINTS = ['/api/satProxy', 'https://view.eumetsat.int/geoserver/wms'];
  var satEndpointIdx = 0;

  /* LRU-кэш готовых тайлов (dataURL по полному URL — включает канал и time).
     Повторный кадр таймлайна/возврат на позицию = 0 сетевых запросов. */
  var satTileCache = new Map(), SAT_CACHE_MAX = IS_MOBILE ? 200 : 450; /* прогрев нескольких слоёв × видимые тайлы (~30КБ/тайл ≈ 13МБ максимум на десктопе) */
  function satCacheSet(url, dataUrl) {
    if (satTileCache.has(url)) satTileCache.delete(url);
    else if (satTileCache.size >= SAT_CACHE_MAX) satTileCache.delete(satTileCache.keys().next().value);
    satTileCache.set(url, dataUrl);
  }

  /* Кэш реколоризованных тайлов: ключ = url + сигнатура палитры */
  var satRecolorCache = new Map(), SAT_RECOLOR_MAX = 150;

  /* Пул загрузки: не более 6 одновременных WMS-запросов, остальные ждут в очереди */
  var satQueue = [], satActiveReq = 0, SAT_MAX_PAR = 6;
  function satPump() {
    while (satActiveReq < SAT_MAX_PAR && satQueue.length) {
      /* Приоритет: тайлы АКТИВНЫХ слоёв (pri 0) раньше фонового прогрева (pri 1) —
         префетч не голодит видимую карту */
      var idx = -1;
      for (var qi = 0; qi < satQueue.length; qi++) { if (!satQueue[qi].pri) { idx = qi; break; } }
      if (idx < 0) idx = 0;
      var job = satQueue.splice(idx, 1)[0];
      /* Тайл мог быть снят Leaflet'ом до старта загрузки (быстрое панорамирование) */
      if (job.tile._satAborted) continue;
      satActiveReq++;
      job.tile._satCounted = true;
      job.tile.src = job.url;
      /* Таймаут отсчитываем от фактического старта запроса, а не постановки в очередь */
      (function(tile) {
        var tmo = tile._satTimeoutMs || 12000;
        tile._satTimer = setTimeout(function() {
          if (!tile._satDone && !tile._satAborted) {
            tile._satTimedOut = true;
            console.warn('[sat] таймаут тайла (' + Math.round(tmo / 1000) + 'с):', tile._satUrl);
            tile.src = ''; /* провоцируем error → штатный путь retry в tileerror */
          }
        }, tmo);
      })(job.tile);
    }
  }
  function satRelease(tile) {
    if (tile._satCounted) { tile._satCounted = false; satActiveReq = Math.max(0, satActiveReq - 1); }
    satPump();
  }

  /* Счётчики прогресса для чипа: ⏳ загружено/всего */
  var satTilesTotal = 0, satTilesDone = 0;

  /* Кастомный слой: createTile с отложенной установкой src (пул) + кэш.
     _tileOnLoad/_tileOnError — приватный API Leaflet 1.9.4 (стабилен), сохраняет
     события loading/load/tileerror, на которые завязан attachSatEvents. */
  var SatWMS = L.TileLayer.WMS.extend({
    createTile: function(coords, done) {
      var tile = document.createElement('img');
      var self = this;
      /* Таймаут тайла: 4x4-прокси получает 16с (холодный старт функции + апстрим),
         остальное — 12с; если за это время ни load, ни error — тайм-аут */
      L.DomEvent.on(tile, 'load', function() {
        tile._satDone = true; clearTimeout(tile._satTimer); satRelease(tile);
        /* Универсальный кэш оригиналов: спутник, ВСЕ 4x4-слои и префетч — одна точка.
           (attachSatEvents кэширует только EUMETSAT; nowcast-тайлы раньше в кэш не попадали —
           одна из причин «данные не прогружаются» после переключений) */
        if (!tile._fromCache && tile._satUrl && tile.src && tile.src.indexOf('data:') !== 0 && !satTileCache.has(tile._satUrl)) {
          enqueueTile({ run: function() {
            try {
              if (tile._recolored || satTileCache.has(tile._satUrl)) return; /* оригинал уже заменён/закэширован */
              var c = document.createElement('canvas'); c.width = c.height = 256;
              c.getContext('2d').drawImage(tile, 0, 0, 256, 256);
              satCacheSet(tile._satUrl, c.toDataURL());
            } catch (err) { /* нет CORS — кэш недоступен, тайл всё равно показывается */ }
          } });
        }
        self._tileOnLoad(done, tile);
      });
      L.DomEvent.on(tile, 'error', function(e) { tile._satDone = true; clearTimeout(tile._satTimer); satRelease(tile); self._tileOnError(done, tile, e); });
      tile.alt = ''; tile.setAttribute('role', 'presentation');
      tile.crossOrigin = 'anonymous'; /* для fallback на прямой эндпоинт; на прокси (свой домен) безвреден */
      var url = this.getTileUrl(coords);
      tile._satUrl = url;
      tile._satTimeoutMs = this.options.tileTimeout || (url.indexOf('/api/nowcastProxy') === 0 ? 16000 : 12000);
      var cached = satTileCache.get(url);
      if (cached) { /* мгновенно из кэша, LRU-обновление */
        satCacheSet(url, cached);
        tile._fromCache = true;
        tile.src = cached;
      } else {
        satQueue.push({ tile: tile, url: url, pri: this.options.prefetch ? 1 : 0 });
        satPump();
      }
      return tile;
    },
    _removeTile: function(key) {
      var t = this._tiles[key];
      if (t && t.el) { t.el._satAborted = true; clearTimeout(t.el._satTimer); } /* не грузить снятые тайлы */
      return L.TileLayer.WMS.prototype._removeTile.call(this, key);
    }
  });

  /* Создание WMS-слоя: канал + опционально время кадра (null = актуальный «LIVE» кадр) */
  function createEumetsatLayer(opacity, channel, ts) {
    var ch = channel || SAT_CHANNELS[satChIdx];
    var params = {
      layers: ch.wms,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      attribution: '© EUMETSAT',
      opacity: opacity !== undefined ? opacity : 0.8,
      tileSize: 256,
      zIndex: 10,           /* поверх тёмной подложки (zIndex 5) на светлых темах */
      maxZoom: 10,          /* как у карты — не гонять WMS на бесполезных зумах */
      updateWhenIdle: false, /* обновление во время движения — карта «живее» */
      keepBuffer: 2
    };
    if (ts) params.time = satIso(ts);
    return new SatWMS(SAT_WMS_ENDPOINTS[satEndpointIdx], params);
  }

  /* ─── Реколоризация grayscale-тайла по палитре канала (через procQueue, ≤8мс/кадр).
     Данные показываются «как есть»: пиксель ищется в палитре по сырой яркости ─── */
  function satPalSignature(pal) { return pal.name + '|' + pal.items.map(function(i) { return i.v + ':' + i.r.join(','); }).join(';'); }
  function recolorSatTile(tile) {
    var ch = SAT_CHANNELS[satChIdx];
    if (!ch.gray) return;
    var pal = satActivePalette();
    if (!pal || pal.noRecolor || pal.legendOnly || !pal.items || !pal.items.length) return;
    var key = tile._satUrl + '\u00a7' + satPalSignature(pal);
    var hit = satRecolorCache.get(key);
    /* Подмена src — тоже через очередь: гарантирует, что кэширование ОРИГИНАЛА
       (задание поставлено раньше в tileload) успеет отработать до перекраски */
    if (hit) { enqueueTile({ run: function() { if (!tile._satAborted) { tile._recolored = true; tile.src = hit; } } }); return; }
    var items = pal.items; /* отсортированы по v убыв. */
    enqueueTile({ run: function() {
      try {
        if (tile._satAborted) return;
        var c = document.createElement('canvas'); c.width = c.height = 256;
        var cc = c.getContext('2d');
        cc.drawImage(tile, 0, 0, 256, 256);
        var idd = cc.getImageData(0, 0, 256, 256), d = idd.data;
        for (var i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue; /* прозрачное — не трогаем */
          var v = (d[i] + d[i + 1] + d[i + 2]) / 3; /* сырая яркость, без калибровки */
          for (var j = 0; j < items.length; j++) {
            if (v >= items[j].v) { d[i] = items[j].r[0]; d[i + 1] = items[j].r[1]; d[i + 2] = items[j].r[2]; break; }
          }
        }
        cc.putImageData(idd, 0, 0);
        var du = c.toDataURL();
        if (satRecolorCache.size >= SAT_RECOLOR_MAX) satRecolorCache.delete(satRecolorCache.keys().next().value);
        satRecolorCache.set(key, du);
        tile._recolored = true;
        tile.src = du;
      } catch (err) { /* canvas tainted (нет CORS) — оставляем оригинал, без падения */ }
    } });
  }

  /* Индикация загрузки/ошибок WMS + retry 1с→2с→4с (макс. 3) + fallback-эндпоинт */
  var satFailStreak = 0;
  var satErrType = 'net'; /* 'timeout' | 'net' — для чипа и тостов */
  function attachSatEvents(lyr) {
    var tries = {};
    lyr.on('loading', function() { if (lyr === eumetsatLayer) { satLoading = true; satTilesTotal = 0; satTilesDone = 0; $('pulse').classList.add('busy'); satUpdateChip(); } });
    lyr.on('tileloadstart', function() { if (lyr === eumetsatLayer) { satTilesTotal++; satUpdateChip(); } });
    lyr.on('tileload', function(e) {
      if (lyr === eumetsatLayer && !e.tile._countedDone) { e.tile._countedDone = true; satTilesDone++; satFailStreak = 0; satUpdateChip(); }
      /* Кэшируем оригинал (если это не data: из кэша) — лениво, через procQueue */
      var t = e.tile;
      if (!t._fromCache && !t._recolored && t._satUrl && t.src && t.src.indexOf('data:') !== 0) {
        (function(tile) { enqueueTile({ run: function() {
          try {
            if (satTileCache.has(tile._satUrl)) return;
            var c = document.createElement('canvas'); c.width = c.height = 256;
            c.getContext('2d').drawImage(tile, 0, 0, 256, 256);
            satCacheSet(tile._satUrl, c.toDataURL());
          } catch (err) { /* нет CORS — кэш недоступен, тайлы всё равно показываются */ }
        } }); })(t);
      }
      if (!t._recolored) recolorSatTile(t);
    });
    lyr.on('load', function() { if (lyr === eumetsatLayer) { satLoading = false; $('pulse').classList.remove('busy'); satUpdateChip(); } });
    lyr.on('tileerror', function(e) {
      var k = e.coords.x + ':' + e.coords.y + ':' + e.coords.z;
      var n = tries[k] || 0;
      if (lyr === eumetsatLayer) satTilesDone++;
      /* Диагностика: тайм-аут отличаем от сетевой/серверной ошибки */
      satErrType = (e.tile && e.tile._satTimedOut) ? 'timeout' : 'net';
      console.warn('[sat] ошибка тайла (' + satErrType + '), попытка ' + (n + 1) + '/4:', e.tile && e.tile._satUrl);
      if (n < 3) { /* экспоненциальный retry: 1с → 2с → 4с */
        tries[k] = n + 1;
        setTimeout(function() { if (map.hasLayer(lyr) && e.tile && !e.tile._satAborted) { e.tile._satDone = false; e.tile._satTimedOut = false; e.tile.src = lyr.getTileUrl(e.coords); } }, 1000 * Math.pow(2, n));
      } else {
        if (lyr.options && lyr.options.prefetch) return; /* префетч тихий: без счётчиков, тостов, чипа и fallback */
        satFailStreak++;
        if (lyr === eumetsatLayer) { satLoading = false; $('pulse').classList.remove('busy'); } /* не висим в .busy вечно */
        var now = Date.now();
        if (now - satErrToastTs > 30000) {
          satErrToastTs = now;
          toast(satErrType === 'timeout' ? '⚠️ Спутник: тайм-аут, повтор…' : '⚠️ Спутник недоступен — нажмите ↻ для повтора');
        }
        satUpdateChip(true);
        /* Fallback: 6+ полностью упавших тайлов подряд и есть зеркало → переключаемся */
        if (satFailStreak >= 6 && SAT_WMS_ENDPOINTS.length > 1) {
          satFailStreak = 0;
          satEndpointIdx = (satEndpointIdx + 1) % SAT_WMS_ENDPOINTS.length;
          toast(satEndpointIdx === 0 ? 'Спутник: возврат на прокси-сервер…' : 'Спутник: переключение на прямой сервер EUMETSAT…');
          setTimeout(function() { satApplyTime(true); }, 1000);
        }
      }
    });
  }

  function loadPalettesFromStorage() {
    try {
      var r = localStorage.getItem('radarPalettes');
      if (r) {
        var parsedR = JSON.parse(r);
        if (Array.isArray(parsedR) && parsedR.length > 0) {
          var customR = parsedR.filter(function(p) { return !p.builtin; });
          palettes.radar.list = [{ name: 'Стандартная (радар)', items: BUILTIN_RADAR, builtin: true }].concat(customR);
        } else { initDefaultPalettes('radar'); }
      } else { initDefaultPalettes('radar'); }

      var w = localStorage.getItem('wxPalettes');
      if (w) {
        var parsedW = JSON.parse(w);
        if (Array.isArray(parsedW) && parsedW.length > 0) {
          var customW = parsedW.filter(function(p) { return !p.builtin; });
          palettes.wx.list = [{ name: 'Стандартная (явления)', items: BUILTIN_WX, builtin: true }].concat(customW);
        } else { initDefaultPalettes('wx'); }
      } else { initDefaultPalettes('wx'); }
    } catch (e) { initDefaultPalettes('radar'); initDefaultPalettes('wx'); }

    /* Палитры спутника: ключ satPalettes = { chId: { custom: [...], activeIdx: n } }.
       Встроенные не сериализуем — восстанавливаются из BUILTIN_SAT */
    try {
      var sp = JSON.parse(localStorage.getItem('satPalettes') || 'null');
      if (sp && typeof sp === 'object') {
        Object.keys(sp).forEach(function(chId) {
          var b = satBucket(chId); var rec = sp[chId] || {};
          var custom = Array.isArray(rec.custom) ? rec.custom.filter(function(p) { return p && !p.builtin && Array.isArray(p.items); }) : [];
          b.list = b.list.filter(function(p) { return p.builtin; }).concat(custom);
          b.activeIdx = (typeof rec.activeIdx === 'number' && rec.activeIdx >= 0 && rec.activeIdx < b.list.length) ? rec.activeIdx : 0;
        });
      }
    } catch (e) {}

    if (palettes.radar.activeIdx >= palettes.radar.list.length) palettes.radar.activeIdx = 0;
    if (palettes.wx.activeIdx >= palettes.wx.list.length) palettes.wx.activeIdx = 0;
  }
  function initDefaultPalettes(layer) { if (layer === 'sat') return; var items = layer === 'radar' ? BUILTIN_RADAR : BUILTIN_WX; var name = layer === 'radar' ? 'Стандартная (радар)' : 'Стандартная (явления)'; palettes[layer].list = [{ name: name, items: items, builtin: true }]; palettes[layer].activeIdx = 0; savePalettesToStorage(layer); }
  function savePalettesToStorage(layer) {
    try {
      if (layer === 'sat') {
        /* Сериализуем только пользовательские палитры по каналам */
        var out = {};
        Object.keys(palettes.sat.byChannel).forEach(function(chId) {
          var b = palettes.sat.byChannel[chId];
          out[chId] = { custom: b.list.filter(function(p) { return !p.builtin; }), activeIdx: b.activeIdx };
        });
        localStorage.setItem('satPalettes', JSON.stringify(out));
        return;
      }
      localStorage.setItem(layer + 'Palettes', JSON.stringify(palettes[layer].list));
    } catch (e) {}
  }
  function getCurrentPaletteItems() {
    var layer = S.layer;
    if (layer === 'sat') { var p = satActivePalette(); return (p && p.items) || []; } /* палитра активного канала */
    var list = palettes[layer].list; var idx = palettes[layer].activeIdx;
    if (!list || list.length === 0 || idx >= list.length) { initDefaultPalettes(layer); idx = 0; }
    return list[idx].items;
  }

  /* ─── Время: сетка и глубина истории зависят от слоя (радар 10 мин / спутник 15 мин) ─── */
  function stepSec() { if (S.layer === 'sat' && (satProduct === 'composite' || satProduct === 'height')) return 600; return S.layer === 'sat' ? SAT_STEP : (S.layer === 'dop' ? 600 : STEP); }   /* доплер/композит: шаг 10 мин */
  function delaySec() { if (S.layer === 'sat' && (satProduct === 'composite' || satProduct === 'height')) return 900; return S.layer === 'sat' ? SAT_DELAY : (S.layer === 'dop' ? 900 : DELAY); } /* задержка публикации BUFR ~15 мин */
  function histSec() { if (S.layer === 'sat' && (satProduct === 'composite' || satProduct === 'height')) return 3 * 3600; return S.layer === 'sat' ? SAT_HISTORY_SEC : (S.layer === 'dop' ? 3 * 3600 : MAX_HISTORY_SEC); } /* история 3 ч */
  function nowTs() { return Math.floor((Date.now() / 1000 - delaySec()) / stepSec()) * stepSec(); }
  function minTs() { return nowTs() - histSec(); }
  S.ts = nowTs();
  function setTime(t, m) { S.ts = Math.max(minTs(), Math.min(t, nowTs())); S.manualTime = !!m; }

  var map = L.map('map', { center: [57, 55], zoom: 6, minZoom: 3, maxZoom: 10, zoomControl: false, fadeAnimation: false, markerZoomAnimation: false, scrollWheelZoom: true, doubleClickZoom: true, boxZoom: true, touchZoom: true, keyboard: true });
  /* crossOrigin: 'anonymous' — CARTO отдаёт CORS *; нужен для экспорта композита
     «карта+слой» (drawImage базовых тайлов без tainted canvas) */
  var darkTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { subdomains: 'abcd', maxZoom: 20, crossOrigin: 'anonymous', attribution: '© OpenStreetMap, © CARTO' });
  var lightTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', { subdomains: 'abcd', maxZoom: 20, crossOrigin: 'anonymous', attribution: '© OpenStreetMap, © CARTO' });
  /* «Схема» — CARTO Voyager: легальный публичный стиль, визуально близкий к схеме Google Maps
     (светлая карта, дороги, подписи). Неофициальные тайлы mt*.google.com/vt НЕ используем —
     нарушение Google ToS без API-ключа и нестабильность. */
  var voyagerTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { subdomains: 'abcd', maxZoom: 20, crossOrigin: 'anonymous', attribution: '© OpenStreetMap, © CARTO' });

  /* ─── БЛОК B: тёмная подложка под спутник на светлых темах ───
     Диагноз: тайлы EUMETSAT грузятся и на light/scheme (сеть/_tiles в норме),
     но grayscale-снимки с белыми «холодными вершинами» при SAT_OPACITY=0.5
     сливаются с белой картой (light_all/Voyager) — контраст, а не сеть.
     Решение (вариант 1, как windy/rainviewer): под спутник подкладываем тёмный
     тайл-слой; тема UI пользователя не меняется. zIndex: подложка 5, спутник 10
     (базовая карта — дефолтный 1). */
  var satBackdropLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { subdomains: 'abcd', maxZoom: 20, zIndex: 5, crossOrigin: 'anonymous', attribution: '© OpenStreetMap, © CARTO' });
  function satBackdropActive() { return map.hasLayer(satBackdropLayer); }
  function updateSatBackdrop(animate) {
    /* тёмная подложка — только под снимками EUMETSAT; продуктам она мешает читать карту */
    var need = (S.layer === 'sat' && !satProduct && currentTheme !== 'dark' && satBackdropOn);
    if (need && !map.hasLayer(satBackdropLayer)) {
      if (animate && !REDUCE_MOTION) {
        /* плавное проявление ~300мс через rAF — без резкого «потемнения» карты */
        satBackdropLayer.setOpacity(0); satBackdropLayer.addTo(map);
        var t0 = performance.now(), D = 300;
        (function step() { var k = Math.min(1, (performance.now() - t0) / D); satBackdropLayer.setOpacity(k); if (k < 1 && map.hasLayer(satBackdropLayer)) requestAnimationFrame(step); })();
      } else { satBackdropLayer.setOpacity(1); satBackdropLayer.addTo(map); }
      satUpdateChip();
    } else if (!need && map.hasLayer(satBackdropLayer)) {
      map.removeLayer(satBackdropLayer); satBackdropLayer.setOpacity(1);
      satUpdateChip();
    }
  }
  darkTileLayer.addTo(map);
  L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(map);
  setTimeout(function() { map.invalidateSize(); }, 500);

  var canvas = $('radar'), ctx = canvas.getContext('2d');
  /* ─── Retina: физический размер = CSS-пиксели × DPR, вся геометрия остаётся в CSS-пикселях
     благодаря ctx.setTransform(DPR,...) в doRender ─── */
  function resizeCanvas() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * DPR);
    canvas.height = Math.round(innerHeight * DPR);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    if (typeof resizeLtgCanvas === 'function') resizeLtgCanvas(); /* канвас молний — тем же размером */
    updThumb(); schedRender();
  }
  addEventListener('resize', resizeCanvas); resizeCanvas();

  /* ─── Crossfade кадров радара: снимок текущего canvas в offscreen-канвас,
     старый кадр гаснет (1-alpha), новый проявляется (alpha) через rAF ─── */
  var prevFrame = { canvas: document.createElement('canvas'), valid: false };
  function startFrameFade() {
    if (S.layer === 'sat') return;
    try {
      if (canvas.width > 0 && canvas.height > 0) {
        prevFrame.canvas.width = canvas.width; prevFrame.canvas.height = canvas.height;
        prevFrame.canvas.getContext('2d').drawImage(canvas, 0, 0);
        prevFrame.valid = true;
      }
    } catch (e) { prevFrame.valid = false; }
    S.fade.active = true; S.fade.start = performance.now(); S.fade.alpha = 0;
  }

  /* ─── Статус-чип (#dbg): слой · время кадра · состояние ─── */
  function setChip(text) { var el = $('dbg'); if (el.textContent !== text) el.textContent = text; }
  function satUpdateChip(err) {
    if (S.layer !== 'sat') return;
    if (satProduct) { prodUpdateChip(); return; } /* активен грозовой продукт — свой чип */
    var ch = SAT_CHANNELS[satChIdx];
    /* Пока не пришёл ни один тайл — честная «загрузка…» вместо ложного LIVE */
    if (satLoading && satTilesDone === 0) { setChip('🛰 ' + ch.label + ' · загрузка… · © EUMETSAT'); return; }
    var live = S.ts >= nowTs();
    var tstr = new Date((live ? nowTs() : S.ts) * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    var prog = satLoading ? ' · ⏳' + Math.min(satTilesDone, satTilesTotal) + '/' + satTilesTotal : '';
    var errTxt = err ? (satErrType === 'timeout' ? ' · ⚠️ таймаут' : ' · ⚠️ сеть/сервер') : '';
    var bd = satBackdropActive() ? ' · подложка' : '';
    setChip('🛰 ' + ch.label + ' · ' + tstr + ' МСК' + (live ? ' (LIVE, ~15 мин задержка)' : '') + prog + errTxt + bd + ' · непрозр. ' + satOpacityMem + '% · © EUMETSAT' + ltgChipSuffix());
  }

  /* ─── Применение времени/канала спутника: новый WMS-слой поверх, старый снимается
     после загрузки нового — ни пустой карты, ни «чёрной вспышки».
     Дебаунс 180мс гасит лавину запросов при перетаскивании трека ─── */
  var satSwapTmr = null;
  function satApplyTime(immediate) {
    if (S.layer !== 'sat') return;
    if (satProduct) { /* продукт вместо канала: composite обновляем по времени, сетка от S.ts не зависит */
      var pdA = prodDef();
      if (pdA && pdA.kind === 'wms') prodWmsApply(immediate);
      return;
    }
    clearTimeout(satSwapTmr);
    satSwapTmr = setTimeout(function() {
      /* За время debounce пользователь мог выбрать «Высота ВГО».
         В этом случае EUMETSAT нельзя создавать поверх самостоятельного слоя. */
      if (S.layer !== 'sat' || satProduct) return;
      var ch = SAT_CHANNELS[satChIdx];
      var live = S.ts >= nowTs();
      var old = eumetsatLayer;
      /* Недогруженный «предыдущий предыдущий» слой убираем сразу */
      if (satOldLayer && map.hasLayer(satOldLayer)) { map.removeLayer(satOldLayer); satOldLayer = null; }
      var lyr = createEumetsatLayer(satOpacityMem / 100, ch, live ? null : S.ts); /* текущее значение сессии — не сбрасывается при смене кадра/канала */
      attachSatEvents(lyr);
      lyr.addTo(map);
      eumetsatLayer = lyr;
      if (old) {
        satOldLayer = old;
        var rm = function() { if (satOldLayer === old && map.hasLayer(old)) { map.removeLayer(old); satOldLayer = null; } };
        lyr.once('load', rm);
        setTimeout(rm, 5000); /* страховка, если 'load' не пришёл (ошибки тайлов) */
      }
      satUpdateChip();
    }, immediate ? 0 : 180);
  }

  /* ═══ Грозовые продукты раздела «Спутник»: COMPOSITE (WMS) и CAPE/CIN/SCP (сетка) ═══ */

  /* ── COMPOSITE: WMS-композит отражаемости через /api/nowcastProxy (свап-паттерн проекта) ── */
  var prodWmsLayer = null, prodWmsOld = null, prodWmsSwapTmr = null, prodWmsErr = false;
  function prodWmsApply(immediate) {
    if (!prodActive() || prodDef().kind !== 'wms') return;
    clearTimeout(prodWmsSwapTmr);
    prodWmsSwapTmr = setTimeout(function() {
      if (!prodActive() || prodDef().kind !== 'wms') return;
      var live = S.ts >= nowTs();
      var old = prodWmsLayer;
      if (prodWmsOld && map.hasLayer(prodWmsOld)) { map.removeLayer(prodWmsOld); prodWmsOld = null; }
      var params = {
        /* height — все станции ВГО одним слоем; composite — выбранный регион */
        layers: satProduct === 'height' ? HEIGHT_NC_LAYERS : COMPOSITE_REGIONS[compositeRegionIdx].id,
        format: 'image/png', transparent: true, version: '1.1.1',
        crs: L.CRS.EPSG4326, tileSize: 256, zIndex: 11, maxZoom: 10,
        updateWhenIdle: false, keepBuffer: 2, opacity: satOpacityMem / 100
      };
      if (!live) params.time = satIso(S.ts);
      var lyr = new SatWMS('/api/nowcastProxy', params);
      lyr.on('load', function() { if (lyr === prodWmsLayer) { prodWmsErr = false; $('pulse').classList.remove('busy'); satUpdateChip(); } });
      lyr.on('loading', function() { if (lyr === prodWmsLayer) { $('pulse').classList.add('busy'); satUpdateChip(); } });
      lyr.on('tileerror', function() { if (lyr === prodWmsLayer) { prodWmsErr = true; satUpdateChip(); } });
      lyr.addTo(map);
      prodWmsLayer = lyr;
      if (old) {
        prodWmsOld = old;
        var rm = function() { if (prodWmsOld === old && map.hasLayer(old)) { map.removeLayer(old); prodWmsOld = null; } };
        lyr.once('load', rm);
        setTimeout(rm, 5000);
      }
      satUpdateChip();
    }, immediate ? 0 : 180);
  }
  function prodWmsRemove() {
    clearTimeout(prodWmsSwapTmr);
    if (prodWmsLayer) { if (map.hasLayer(prodWmsLayer)) map.removeLayer(prodWmsLayer); prodWmsLayer = null; }
    if (prodWmsOld) { if (map.hasLayer(prodWmsOld)) map.removeLayer(prodWmsOld); prodWmsOld = null; }
    prodWmsErr = false;
  }
  function setCompositeRegion(idx) {
    if (idx < 0 || idx >= COMPOSITE_REGIONS.length || idx === compositeRegionIdx) return;
    compositeRegionIdx = idx;
    try { localStorage.setItem('prodCompositeRegion', COMPOSITE_REGIONS[idx].id); } catch (e) {}
    if (prodActive() && prodDef().kind === 'wms') prodWmsApply(true);
    buildLegend();
    toast('COMPOSITE: ' + COMPOSITE_REGIONS[idx].label);
  }

  /* ── CAPE/CIN/SCP: сетка Open-Meteo (CORS *, без ключа) на канвасе #prod-canvas.
     Один запрос тянет ВСЕ переменные (cape, convective_inhibition, ветер 10/180 м) —
     переключение продуктов не требует рефетча. Батчи по 50 точек, AbortController,
     TTL 10 мин, пересчёт при moveend (дебаунс 600мс) и раз в 15 мин. ── */
  var prodCanvas = document.createElement('canvas');
  prodCanvas.id = 'prod-canvas';
  document.body.appendChild(prodCanvas);
  var prodCtx = prodCanvas.getContext('2d');
  function prodResizeCanvas() {
    prodCanvas.width = Math.round(innerWidth * DPR); prodCanvas.height = Math.round(innerHeight * DPR);
    prodCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  prodResizeCanvas();
  window.addEventListener('resize', function() { prodResizeCanvas(); schedProdDraw(); });
  var prodGrid = { pts: [], times: null, hourIdx: 0, key: '', fetchedAt: 0, ctrl: null, loading: false, err: null };
  function prodGridActive() { return prodActive() && prodDef().kind === 'grid'; }
  function prodGridKey(b, cols, rows) {
    var r = function(v) { return Math.round(v * 2) / 2; };
    return [r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth()), cols, rows].join('|');
  }
  function fetchProdGrid(force) {
    if (!prodGridActive()) return;
    var b = map.getBounds();
    /* ячейка ~110px экрана; потолок 12×10 = 120 точек (лимиты Open-Meteo щадим) */
    var cols = Math.max(4, Math.min(12, Math.round(innerWidth / 110)));
    var rows = Math.max(4, Math.min(10, Math.round(innerHeight / 110)));
    var key = prodGridKey(b, cols, rows);
    if (!force && key === prodGrid.key && Date.now() - prodGrid.fetchedAt < 10 * 60 * 1000) { schedProdDraw(); return; }
    if (prodGrid.ctrl) prodGrid.ctrl.abort();
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    prodGrid.ctrl = ctrl; prodGrid.loading = true; prodGrid.err = null; satUpdateChip();
    var dLat = (b.getNorth() - b.getSouth()) / rows, dLon = (b.getEast() - b.getWest()) / cols;
    var pts = [];
    for (var ry = 0; ry < rows; ry++) for (var cx = 0; cx < cols; cx++) {
      var lat = b.getSouth() + (ry + 0.5) * dLat, lon = b.getWest() + (cx + 0.5) * dLon;
      if (lat > 84 || lat < -84) continue; /* за пределами данных модели */
      pts.push({ lat: +lat.toFixed(3), lon: +lon.toFixed(3), dLat: dLat / 2, dLon: dLon / 2, v: null });
    }
    var batches = [];
    for (var i0 = 0; i0 < pts.length; i0 += 50) batches.push(pts.slice(i0, i0 + 50));
    Promise.all(batches.map(function(batch) {
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + batch.map(function(p) { return p.lat; }).join(',') +
        '&longitude=' + batch.map(function(p) { return p.lon; }).join(',') +
        '&hourly=cape,convective_inhibition,wind_speed_10m,wind_speed_180m&forecast_days=1';
      return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(j) {
        var arr = Array.isArray(j) ? j : [j];
        arr.forEach(function(res, i) {
          if (batch[i] && res && res.hourly) batch[i].v = res.hourly;
          if (!prodGrid.times && res && res.hourly && res.hourly.time) prodGrid.times = res.hourly.time;
        });
      });
    })).then(function() {
      if (prodGrid.ctrl !== ctrl) return; /* пришёл более новый запрос */
      /* индекс часа: ближайший к текущему времени (модель почасовая, UTC) */
      var hi = 0;
      if (prodGrid.times) {
        var now = Date.now(), bd2 = 1e15;
        prodGrid.times.forEach(function(t, i) { var d = Math.abs(Date.parse(t + 'Z') - now); if (d < bd2) { bd2 = d; hi = i; } });
      }
      prodGrid.pts = pts; prodGrid.hourIdx = hi; prodGrid.key = key; prodGrid.fetchedAt = Date.now();
      prodGrid.loading = false; prodGrid.err = null;
      satUpdateChip(); schedProdDraw();
    }).catch(function(e) {
      if (prodGrid.ctrl !== ctrl || (e && e.name === 'AbortError')) return;
      prodGrid.loading = false; prodGrid.err = 'сеть/сервер';
      satUpdateChip();
    });
  }
  /* Шкалы продуктов (стопы — общепринятые метео-градации конвективных индексов) */
  function capeColor(v) { /* Дж/кг: <100 незначимо */
    if (!(v >= 100)) return null;
    if (v < 500) return [74, 222, 128];    /* слабая неустойчивость */
    if (v < 1000) return [253, 224, 71];   /* умеренная */
    if (v < 2000) return [249, 115, 22];   /* сильная */
    if (v < 3000) return [220, 38, 38];    /* очень сильная */
    return [162, 28, 175];                 /* экстремальная */
  }
  function cinColor(v) { /* Дж/кг задерживающей энергии: <15 незначимо */
    if (!(v >= 15)) return null;
    if (v < 50) return [147, 197, 253];    /* слабое подавление */
    if (v < 100) return [59, 130, 246];    /* умеренное */
    if (v < 200) return [29, 78, 216];     /* сильное */
    return [107, 33, 168];                 /* конвекция маловероятна */
  }
  /* SCP-оценка: совместно CAPE и сдвиг ветра 10→180 м (proxy сдвига 0–6 км, м/с).
     Пороги приближённые: суперячейки требуют И энергии, И сдвига. НЕ SCP NOAA. */
  function scpScore(cape, shearMs) {
    if (cape >= 2500 && shearMs >= 20) return 3;
    if (cape >= 1500 && shearMs >= 15) return 2;
    if (cape >= 800 && shearMs >= 12) return 1;
    return 0;
  }
  var SCP_COLORS = [null, [253, 224, 71], [249, 115, 22], [220, 38, 38]];
  function prodCellColor(p) {
    if (!p.v) return null;
    var hi = prodGrid.hourIdx;
    if (satProduct === 'cape') return capeColor(p.v.cape ? p.v.cape[hi] : null);
    if (satProduct === 'cin') return cinColor(p.v.convective_inhibition ? p.v.convective_inhibition[hi] : null);
    if (satProduct === 'scp') {
      var cape = p.v.cape ? p.v.cape[hi] : 0;
      var shear = ((p.v.wind_speed_180m ? p.v.wind_speed_180m[hi] : 0) - (p.v.wind_speed_10m ? p.v.wind_speed_10m[hi] : 0)) / 3.6; /* км/ч → м/с */
      return SCP_COLORS[scpScore(cape || 0, shear || 0)];
    }
    return null;
  }
  /* Общая отрисовка ячеек (экран и экспорт): полупрозрачные прямоугольники */
  function drawProdCells(ctx) {
    var n = 0;
    prodGrid.pts.forEach(function(p) {
      var col = prodCellColor(p);
      if (!col) return;
      var c1 = map.latLngToContainerPoint(L.latLng(p.lat + p.dLat, p.lon - p.dLon));
      var c2 = map.latLngToContainerPoint(L.latLng(p.lat - p.dLat, p.lon + p.dLon));
      ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0.45)';
      ctx.fillRect(Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), Math.abs(c2.x - c1.x) + 1, Math.abs(c2.y - c1.y) + 1);
      n++;
    });
    return n;
  }
  var prodDrawPending = false;
  function schedProdDraw() {
    if (prodDrawPending) return;
    prodDrawPending = true;
    requestAnimationFrame(function() {
      prodDrawPending = false;
      prodCtx.clearRect(0, 0, innerWidth, innerHeight);
      if (prodGridActive()) drawProdCells(prodCtx);
    });
  }
  /* Канвас следует за картой; refetch — по покою карты */
  var prodMoveTmr = null;
  map.on('move zoom', function() { if (prodGridActive()) schedProdDraw(); });
  map.on('moveend', function() {
    if (!prodGridActive()) return;
    schedProdDraw();
    clearTimeout(prodMoveTmr);
    prodMoveTmr = setTimeout(function() { fetchProdGrid(false); }, 600);
  });
  setInterval(function() { /* модель обновляется нечасто — 15 мин достаточно */
    if (prodGridActive() && document.visibilityState === 'visible') fetchProdGrid(true);
  }, 15 * 60 * 1000);

  /* ── Вход/выход продукта: WMS-слой или сетка; таймлайн только у composite ── */
  function prodEnter() {
    var pd = prodDef();
    if (!pd) return;
    /* Высота ВГО — самостоятельный слой: отменяем отложенный запуск спутника,
       снимаем оба EUMETSAT-слоя и спутниковую тёмную подложку. */
    clearTimeout(satSwapTmr); satSwapTmr = null;
    if (eumetsatLayer) { if (map.hasLayer(eumetsatLayer)) map.removeLayer(eumetsatLayer); eumetsatLayer = null; }
    if (satOldLayer) { if (map.hasLayer(satOldLayer)) map.removeLayer(satOldLayer); satOldLayer = null; }
    satLoading = false; $('pulse').classList.remove('busy');
    updateSatBackdrop(false);
    if (pd.kind === 'wms') {
      if (!hiddenPanels['tl']) $('tl').style.display = 'flex'; /* композит: история, шаг 10 мин */
      S.manualTime = false; S.ts = nowTs(); buildFrames(); updHUD();
      prodWmsApply(true);
    } else {
      $('tl').style.display = 'none'; $('restore-tl').style.display = 'none'; /* модель почасовая — таймлайн не нужен */
      prodCanvas.style.display = 'block';
      fetchProdGrid(true);
    }
    buildLegend(); satUpdateChip();
  }
  function prodExit() {
    prodWmsRemove();
    if (prodGrid.ctrl) { prodGrid.ctrl.abort(); prodGrid.ctrl = null; }
    prodGrid.loading = false;
    prodCanvas.style.display = 'none';
    prodCtx.clearRect(0, 0, innerWidth, innerHeight);
    if (S.layer === 'sat' && !hiddenPanels['tl']) $('tl').style.display = 'flex';
  }
  function setSatProduct(id) {
    if (id === satProduct) return;
    var prev = satProduct;
    satProduct = id;
    try { if (id) localStorage.setItem('satProduct', id); else localStorage.removeItem('satProduct'); } catch (e) {}
    if (S.layer !== 'sat') { syncChannelUI(); return; } /* применится при входе в sat */
    satPrefetchCancel(); /* активный продукт сменился — пересобрать план прогрева */
    if (prev) prodExit();
    if (id) {
      prodEnter();
      toast('Продукт: ' + prodDef().label);
    } else {
      /* возврат к каналу EUMETSAT */
      S.manualTime = false; S.ts = nowTs(); buildFrames(); updHUD();
      satApplyTime(true);
      updateSatBackdrop(true);
      buildLegend(); satUpdateChip();
      toast('Канал: ' + SAT_CHANNELS[satChIdx].label);
    }
    syncChannelUI();
    saveViewDebounced();
  }
  /* Чип продуктов: источники — 4x4 (композит) и Open-Meteo (модельная сетка) */
  function prodUpdateChip() {
    var pd = prodDef();
    if (!pd) return;
    if (pd.kind === 'wms') {
      var live = S.ts >= nowTs();
      var tstr = new Date((live ? nowTs() : S.ts) * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
      var head = satProduct === 'height' ? 'Высота ВГО · 4x4 (BUFR)' : 'COMPOSITE · 4x4 (' + COMPOSITE_REGIONS[compositeRegionIdx].label + ')';
      setChip(head + ' · ' + tstr + ' МСК' + (live ? ' (LIVE)' : '') + (prodWmsErr ? ' · ⚠️ ошибки тайлов' : '') + ltgChipSuffix());
    } else {
      var hstr = (prodGrid.times && prodGrid.times[prodGrid.hourIdx])
        ? new Date(Date.parse(prodGrid.times[prodGrid.hourIdx] + 'Z')).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';
      var name = pd.id === 'cape' ? 'CAPE' : (pd.id === 'cin' ? 'CIN' : 'SUPERCELL · оценка');
      setChip(name + ' · Open-Meteo · ' + hstr + ' МСК · ' + prodGrid.pts.length + ' точек' + (prodGrid.loading ? ' · ⏳' : '') + (prodGrid.err ? ' · ⚠️ ' + prodGrid.err : '') + ltgChipSuffix());
    }
  }

  /* ─── Crossfade канваса радара при переключении radar↔sat (вместо резкого display) ─── */
  function canvasShouldHide() { return (S.layer !== 'radar' && S.layer !== 'wx') || !S.dbzVisible || radarNcActive(); }
  function fadeCanvas(show) {
    var target = parseInt($('opacity-slider').value) / 100;
    if (REDUCE_MOTION) { canvas.style.display = show ? 'block' : 'none'; canvas.style.opacity = target; return; }
    if (show) {
      canvas.style.display = 'block'; canvas.style.opacity = 0; void canvas.offsetWidth;
      canvas.classList.add('cfade'); canvas.style.opacity = target;
      setTimeout(function() { canvas.classList.remove('cfade'); }, 300);
    } else {
      canvas.classList.add('cfade'); canvas.style.opacity = 0;
      setTimeout(function() { canvas.classList.remove('cfade'); if (canvasShouldHide()) canvas.style.display = 'none'; canvas.style.opacity = target; }, 280);
    }
  }

  /* ─── БЛОК D: скрытие/показ слоя dBZ (кнопка-«глаз») ─── */
  function applyDbzUI() {
    var btn = $('btn-toggle-dbz');
    if (!btn) return;
    btn.textContent = S.dbzVisible ? '👁' : '🙈';
    btn.title = S.dbzVisible ? 'Скрыть слой осадков' : 'Показать слой осадков';
    btn.classList.toggle('on', !S.dbzVisible);
    /* Слайдер прозрачности неактивен, пока слой скрыт */
    var slider = $('opacity-slider');
    if (S.layer !== 'sat') { slider.disabled = !S.dbzVisible; $('opacity-control').classList.toggle('disabled', !S.dbzVisible); }
    /* Легенда приглушается + подпись «слой скрыт» в чипе (см. doRender) */
    $('legend').classList.toggle('dbz-off', !S.dbzVisible && S.layer !== 'sat');
  }
  function toggleDbz() {
    if (S.layer === 'sat') { toast('В режиме спутника слой dBZ не отображается'); return; }
    S.dbzVisible = !S.dbzVisible;
    fadeCanvas(S.dbzVisible); /* плавное затухание/проявление 250–300мс, reduced-motion — мгновенно */
    if (radarNcLayer) radarNcLayer.setOpacity(S.dbzVisible ? (parseInt($('opacity-slider').value) || 100) / 100 : 0); /* WMS-режим */
    wxNcExtras.forEach(function(l) { l.setOpacity(S.dbzVisible ? (parseInt($('opacity-slider').value) || 100) / 100 : 0); }); /* доп. станции ОЯ */
    applyDbzUI();
    if (S.dbzVisible) schedRender(); else { hidePopup(); hoverEl.style.display = 'none'; }
    saveViewDebounced();
    toast(S.dbzVisible ? 'Слой осадков показан' : 'Слой осадков скрыт');
  }

  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * (1 << z)); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z)); }
  function x2lon(x, z) { return x / (1 << z) * 360 - 180; }
  function y2lat(y, z) { var n = Math.PI - 2 * Math.PI * y / (1 << z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }
  function visTiles() { var b = map.getBounds(), mx = (1 << FZ) - 1, x0 = Math.max(0, lon2x(b.getWest(), FZ)), x1 = Math.min(mx, lon2x(b.getEast(), FZ)), y0 = Math.max(0, lat2y(b.getNorth(), FZ)), y1 = Math.min(mx, lat2y(b.getSouth(), FZ)), l = []; for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) l.push({ x: x, y: y }); return l; }
  function tileRect(x, y) { var nw = map.latLngToContainerPoint(L.latLng(y2lat(y, FZ), x2lon(x, FZ))); var se = map.latLngToContainerPoint(L.latLng(y2lat(y + 1, FZ), x2lon(x + 1, FZ))); return { sx: Math.round(nw.x), sy: Math.round(nw.y), sw: Math.round(se.x - nw.x), sh: Math.round(se.y - nw.y) }; }
  function makeCK(l, t, p, x, y) { return l + '|' + t + '|' + p + '|' + x + '|' + y; }
  function CK(x, y) { return makeCK(S.layer, S.ts, S.px, x, y); }
  function getColor(raw) { if (raw < MDBZ) return null; var items = getCurrentPaletteItems(); for (var i = 0; i < items.length; i++) { if (raw >= items[i].v) return items[i].r; } return null; }

  function interpolateRaw(raw, w, h, scale) {
    var nw = w * scale, nh = h * scale; var newRaw = new Float32Array(nw * nh);
    for (var y = 0; y < nh; y++) { for (var x = 0; x < nw; x++) {
      var gx = x / scale, gy = y / scale; var x0 = Math.floor(gx), y0 = Math.floor(gy); var x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
      var tx = gx - x0, ty = gy - y0; var p00 = raw[y0 * w + x0], p01 = raw[y0 * w + x1], p10 = raw[y1 * w + x0], p11 = raw[y1 * w + x1];
      if (p00 < 0 && p01 < 0 && p10 < 0 && p11 < 0) { newRaw[y * nw + x] = -1; } 
      else { var sum = 0, count = 0; if (p00 >= 0) { sum += p00 * (1-tx) * (1-ty); count += (1-tx)*(1-ty); } if (p01 >= 0) { sum += p01 * tx * (1-ty); count += tx*(1-ty); } if (p10 >= 0) { sum += p10 * (1-tx) * ty; count += (1-tx)*ty; } if (p11 >= 0) { sum += p11 * tx * ty; count += tx*ty; } newRaw[y * nw + x] = count > 0 ? sum / count : -1; }
    } }
    return { data: newRaw, w: nw, h: nh };
  }

  function applySmoothing(raw, w, h, strength) { 
    if (strength === 0) return raw; 
    var size = strength * 2 + 1; var half = Math.floor(size / 2); var result = new Float32Array(raw.length); var kernel = []; var sigma = strength * 0.6 + 0.5; var sum = 0; 
    for (var i = -half; i <= half; i++) { for (var j = -half; j <= half; j++) { var d = Math.sqrt(i * i + j * j); var val = Math.exp(-(d * d) / (2 * sigma * sigma)); kernel.push(val); sum += val; } } 
    for (var ki = 0; ki < kernel.length; ki++) kernel[ki] /= sum; 
    var kw = size, kh = size; 
    for (var y = 0; y < h; y++) { for (var x = 0; x < w; x++) { var acc = 0, wsum = 0; for (var ky = -half; ky <= half; ky++) { for (var kx = -half; kx <= half; kx++) { var px = x + kx, py = y + ky; if (px < 0 || px >= w || py < 0 || py >= h) continue; var idx = py * w + px; if (raw[idx] >= 0) { var kidx = (ky + half) * kw + (kx + half); acc += raw[idx] * kernel[kidx]; wsum += kernel[kidx]; } } } var idx2 = y * w + x; result[idx2] = (wsum > 0) ? acc / wsum : -1; } } 
    return result; 
  }

  function processTile(img, px, smooth, smoothStrength) {
    var src = document.createElement('canvas'); src.width = src.height = 256; var sc = src.getContext('2d'); sc.drawImage(img, 0, 0);
    var id = sc.getImageData(0, 0, 256, 256), d = id.data; var w = 256, h = 256; var raw = new Float32Array(w * h);
    for (var i = 0; i < d.length; i += 4) { if (d[i + 3] > 0) { var v = (d[i] + d[i + 1] + d[i + 2]) / 3 | 0; raw[i / 4] = v; } else { raw[i / 4] = -1; } }
    var targetRaw = raw, targetW = w, targetH = h;
    /* На мобильных пропускаем 2× интерполяцию (px<1): в 4 раза меньше вычислений, разница на экране телефона незаметна */
    if (px < 1 && !IS_MOBILE) { var scale = 1 / px; var interp = interpolateRaw(raw, w, h, scale); targetRaw = interp.data; targetW = interp.w; targetH = interp.h; }
    var smoothed = targetRaw;
    if (smooth && smoothStrength > 0) { smoothed = applySmoothing(targetRaw, targetW, targetH, smoothStrength); }
    var out = document.createElement('canvas'); out.width = targetW; out.height = targetH; var oc = out.getContext('2d'); oc.imageSmoothingEnabled = false;
    var effectivePx = (px < 1) ? 1 : px; var bw = Math.ceil(targetW / effectivePx), bh = Math.ceil(targetH / effectivePx);
    for (var py = 0; py < bh; py++) { for (var pxx = 0; pxx < bw; pxx++) {
      var x0 = pxx * effectivePx, y0 = py * effectivePx, x1 = Math.min(x0 + effectivePx, targetW), y1 = Math.min(y0 + effectivePx, targetH);
      var sum = 0, n = 0;
      for (var yy = y0; yy < y1; yy++) { for (var xx = x0; xx < x1; xx++) { var idx = yy * targetW + xx; if (smoothed[idx] >= 0) { sum += smoothed[idx]; n++; } } }
      if (n > 0) { var avg = Math.round(sum / n); var rgb = getColor(avg); if (rgb) { oc.fillStyle = 'rgb(' + rgb.join(',') + ')'; oc.fillRect(x0, y0, x1 - x0, y1 - y0); } }
    } }
    return { canvas: out, raw: smoothed, px: px, scaled: false };
  }

  function bumpLoad(d) { S.loadN = Math.max(0, S.loadN + d); $('pulse').classList.toggle('busy', S.loadN > 0 || satLoading); }

  /* ─── Очередь обработки тайлов: тяжёлые processTile выполняются порциями ≤8мс на кадр rAF,
     чтобы главный поток (и UI) не замирал при сглаживании/смене разрешения ─── */
  var procQueue = [], procScheduled = false;
  function drainProcQueue() {
    procScheduled = false;
    var t0 = performance.now();
    while (procQueue.length && (performance.now() - t0) < 8) {
      var job = procQueue.shift();
      if (job.run) { try { job.run(); } catch (e) {} continue; } /* универсальные задания (реколоризация спутника и т.п.) */
      if (S.ts !== job.sts || S.layer !== job.sl) continue; /* кадр уже неактуален */
      try {
        var result = processTile(job.img, job.spx, job.ssmooth, job.sstrength);
        if (S.cache.size >= S.cacheMax) S.cache.delete(S.cache.keys().next().value);
        S.cache.set(job.ck, result);
      } catch (e) { S.failed.add(job.ck); }
    }
    if (procQueue.length && !procScheduled) { procScheduled = true; requestAnimationFrame(drainProcQueue); }
    schedRender();
  }
  function enqueueTile(job) { procQueue.push(job); if (!procScheduled) { procScheduled = true; requestAnimationFrame(drainProcQueue); } }

  function fetchTile(x, y) {
    var ck = CK(x, y); if (S.cache.has(ck) || S.pending.has(ck) || S.failed.has(ck)) return;
    S.pending.add(ck); bumpLoad(1); var url = SRC + '/' + S.ts + '/' + FZ + '/' + x + '_' + y + '.png'; var img = new Image(); img.crossOrigin = 'anonymous';
    var spx = S.px, sl = S.layer, sts = S.ts, ssmooth = S.smooth, sstrength = S.smoothStrength;
    var tid = setTimeout(function() { S.pending.delete(ck); bumpLoad(-1); S.failed.add(ck); }, 8000);
    img.onload = function() { clearTimeout(tid); S.pending.delete(ck); bumpLoad(-1); if (S.ts !== sts || S.layer !== sl) return; enqueueTile({ img: img, ck: ck, spx: spx, sl: sl, sts: sts, ssmooth: ssmooth, sstrength: sstrength }); };
    img.onerror = function() { clearTimeout(tid); S.pending.delete(ck); bumpLoad(-1); S.failed.add(ck); };
    img.src = url;
  }

  var renderPend = false;
  function schedRender() { if (!renderPend) { renderPend = true; requestAnimationFrame(doRender); } }
  function doRender() {
    renderPend = false;
    /* DPR-масштаб: рисуем в CSS-пикселях, физически — в device-пикселях (чёткость на retina) */
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (S.layer === 'sat') { satUpdateChip(); return; }
    if (radarNcActive()) { /* dBZ с nowcast: рисует WMS-слой, канвас пуст */
      var liveNc = S.ts >= nowTs();
      var tNc = new Date((liveNc ? nowTs() : S.ts) * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
      setChip((S.layer === 'wx' ? 'ОЯ · 4x4 (BUFR: Мск·Нвс·Влд)' : 'dBZ · 4x4 (' + RADAR_NC_LAYERS[radarNcIdx].label + ')') + ' · ' + tNc + ' МСК' + (liveNc ? ' (LIVE)' : '') + (radarNcLoading ? ' · ⏳' : '') + (radarNcErr ? ' · ⚠️ ' + radarNcErr : '') + (!S.dbzVisible ? ' · слой скрыт' : '') + ltgChipSuffix());
      return;
    }
    if (S.layer === 'dop') { dopUpdateChip(); return; }
    /* Слой скрыт кнопкой-«глазом»: не тратим CPU на отрисовку */
    if (!S.dbzVisible) { setChip((S.layer === 'radar' ? 'dBZ' : 'ОЯ') + ' · слой скрыт'); return; }
    if (S.fade.active) { var elapsed = (performance.now() - S.fade.start) / S.fade.duration; if (elapsed >= 1) { S.fade.active = false; S.fade.alpha = 1; prevFrame.valid = false; } else { S.fade.alpha = Math.min(elapsed, 1); S.fade.alpha = 1 - Math.pow(1 - S.fade.alpha, 3); schedRender(); } }
    var alpha = S.fade.active ? S.fade.alpha : 1; var tiles = visTiles();
    /* Старый кадр гаснет под новым; снимок хранится в device-пикселях → рисуем с identity-матрицей */
    if (S.fade.active && prevFrame.valid) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1 - alpha; ctx.drawImage(prevFrame.canvas, 0, 0); ctx.restore(); }
    ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = false;
    var hit = 0, miss = 0;
    for (var i = 0; i < tiles.length; i++) { 
      var t = tiles[i], ck = CK(t.x, t.y), entry = S.cache.get(ck); 
      if (entry && entry.canvas) { var r = tileRect(t.x, t.y); if (r.sw > 0 && r.sh > 0) { ctx.drawImage(entry.canvas, r.sx, r.sy, r.sw, r.sh); hit++; } } else { fetchTile(t.x, t.y); miss++; } 
    }
    ctx.globalAlpha = 1;
    /* Статус-чип: слой · время кадра МСК · загрузка */
    var lname = S.layer === 'radar' ? 'dBZ' : 'ОЯ';
    var tstr = new Date(S.ts * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    setChip(lname + (S.layer === 'radar' ? ' · rainradar' : '') + ' · ' + tstr + ' МСК' + (miss > 0 ? ' · ⏳' + miss : '') + ltgChipSuffix());
    if (S.layer === 'wx') { ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1; ctx.beginPath(); for (var gi = 0; gi < tiles.length; gi++) { var gt = tiles[gi], gr = tileRect(gt.x, gt.y); if (gr.sw <= 0 || gr.sh <= 0) continue; var scX = gr.sw / 256, scY = gr.sh / 256, bW = S.px * scX, bH = S.px * scY; if (bW < 1 || bH < 1) continue; var cols = Math.ceil(256 / S.px); for (var ci = 0; ci <= cols; ci++) { var lx = gr.sx + Math.round(ci * bW) + 0.5; ctx.moveTo(lx, gr.sy); ctx.lineTo(lx, gr.sy + gr.sh); } for (var ri = 0; ri <= cols; ri++) { var ly = gr.sy + Math.round(ri * bH) + 0.5; ctx.moveTo(gr.sx, ly); ctx.lineTo(gr.sx + gr.sw, ly); } } ctx.stroke(); ctx.restore(); }
  }

  map.on('move', schedRender); map.on('movestart', function() { prevFrame.valid = false; }); map.on('moveend zoomend', function() { if (S.layer !== 'sat') S.failed.clear(); schedRender(); });

  /* ═══ БЛОК C: грозопеленгатор (оверлей-тумблер ⚡): молнии — самостоятельный
     слой ПОВЕРХ любого выбранного (радар/ОЯ/спутник/карта). ═══ */
  /* ═══ Молнии: ПУБЛИЧНЫЙ WebSocket Blitzortung (без кредов и прокси).
     Протокол (сверен живым подключением из этого проекта):
       wss://ws1.blitzortung.org → в onopen шлём {"a":111} → сервер push'ит удары.
     Сообщения СЖАТЫ символьным LZW (как на lightningmaps) → ltgLzwDecode().
     Поля удара: time (наносекунды unix!), lat/lon (+ поправки latc/lonc — прибавить),
     delay (задержка публикации, с), mds/status/sig — служебные.
     api/lightning.js (Protected API с BLITZORTUNG_USER/PASS) больше НЕ вызывается. */
  var ltg = { on: false, strikes: [], lastAt: 0, err: null, ws: null, wsTry: 0, wsTmr: null };
  var LTG_WS_SERVERS = ['wss://ws1.blitzortung.org/', 'wss://ws7.blitzortung.org/', 'wss://ws8.blitzortung.org/'];
  var ltgWsIdx = 0; /* при ошибке пробуем следующий сервер по кругу */
  var LTG_MAX = 2000; /* лимит массива ударов — вытесняем самые старые */
  var ltgErrToastTs = 0;
  var ltgCanvas = $('ltg-canvas'), ltgCtx = ltgCanvas ? ltgCanvas.getContext('2d') : null;
  /* Символьный LZW-декодер потока Blitzortung (портирован с официального клиента) */
  function ltgLzwDecode(b) {
    if (!b) return b;
    var e = {}, c = b.charAt(0), f = c, g = [c], h = 256, o = h, a;
    for (var i = 1; i < b.length; i++) {
      a = b.charCodeAt(i);
      a = h > a ? b.charAt(i) : (e[a] ? e[a] : f + c);
      g.push(a);
      c = a.charAt(0);
      e[o] = f + c; o++;
      f = a;
    }
    return g.join('');
  }
  function resizeLtgCanvas() {
    if (!ltgCanvas) return;
    ltgCanvas.width = Math.round(innerWidth * DPR); ltgCanvas.height = Math.round(innerHeight * DPR);
    ltgCanvas.style.width = innerWidth + 'px'; ltgCanvas.style.height = innerHeight + 'px';
    drawLtg();
  }
  /* Общая отрисовка (экран и экспорт-композит): контекст уже в CSS-пикселях (DPR-transform).
     В композит идут ТОЛЬКО квадраты (кольца — живая анимация, в статике не нужна) */
  function drawLtgToCtx(c2) {
    var now = Date.now() / 1000;
    for (var i = 0; i < ltg.strikes.length; i++) {
      var st = ltg.strikes[i], age = now - st[2];
      if (age < 0 || age > 600) continue; /* старше 10 мин не рисуем */
      /* Затухание: ≤2 мин — непрозрачные; 2–10 мин — линейно до 0.25 */
      var a = age <= 120 ? 1 : Math.max(0.25, 1 - (age - 120) / 480 * 0.75);
      var pt = map.latLngToContainerPoint([st[0], st[1]]);
      if (pt.x < -8 || pt.x > innerWidth + 8 || pt.y < -8 || pt.y > innerHeight + 8) continue;
      c2.globalAlpha = a;
      c2.fillStyle = '#ffd400'; /* жёлтый квадрат */
      c2.strokeStyle = 'rgba(0,0,0,0.5)'; c2.lineWidth = 1;
      c2.fillRect(pt.x - 3, pt.y - 3, 6, 6);
      c2.strokeRect(pt.x - 3.5, pt.y - 3.5, 7, 7); /* тёмная обводка — видно на любой карте */
    }
    c2.globalAlpha = 1;
  }
  /* Кольцо-волна свежего удара (как в официальном клиенте): ~0.9с, только экран.
     Отключается при reduced-motion/animPref off */
  var ltgRings = []; /* [lat, lon, performance.now() рождения] */
  function ltgRingAdd(lat, lon) {
    if (REDUCE_MOTION) return;
    ltgRings.push([lat, lon, performance.now()]);
    if (ltgRings.length > 60) ltgRings.shift(); /* при шторме не копим лавину колец */
  }
  function drawLtgRings(c2) {
    if (!ltgRings.length) return;
    var now = performance.now(), alive = [];
    for (var i = 0; i < ltgRings.length; i++) {
      var r = ltgRings[i], k = (now - r[2]) / 900;
      if (k >= 1) continue;
      var pt = map.latLngToContainerPoint([r[0], r[1]]);
      c2.beginPath(); c2.arc(pt.x, pt.y, 4 + k * 26, 0, Math.PI * 2);
      c2.strokeStyle = 'rgba(255,255,255,' + (0.8 * (1 - k)).toFixed(3) + ')';
      c2.lineWidth = 1.5; c2.stroke();
      alive.push(r);
    }
    ltgRings = alive;
    if (ltgRings.length) drawLtg(); /* анимация продолжается, пока живы кольца */
  }
  var ltgDrawPend = false;
  function drawLtg() { /* rAF-троттлинг перерисовки при панорамировании/потоке */
    if (!ltgCtx || ltgDrawPend) return;
    ltgDrawPend = true;
    requestAnimationFrame(function() {
      ltgDrawPend = false;
      ltgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ltgCtx.clearRect(0, 0, innerWidth, innerHeight);
      if (ltg.on && ltg.strikes.length) drawLtgToCtx(ltgCtx);
      if (ltg.on) drawLtgRings(ltgCtx);
    });
  }
  function ltgChipSuffix() {
    if (!ltg.on) return '';
    if (ltg.err) return ' · ⚡ нет соединения';
    if (!ltg.ws || ltg.ws.readyState !== 1) return ' · ⚡ подключение…';
    var sfx = ' · ⚡' + ltg.strikes.length;
    if (ltg.strikes.length) { /* возраст самого свежего удара — видно, что поток живой */
      var ago = Math.max(0, Math.round(Date.now() / 1000 - ltg.strikes[ltg.strikes.length - 1][2]));
      sfx += ' · ' + (ago < 60 ? ago + 'с' : Math.round(ago / 60) + ' мин') + ' назад';
    }
    return sfx;
  }
  /* Троттлинг обновления чипа: при грозе push идёт очередями, чип чаще 1с не дёргаем */
  var ltgUiTs = 0;
  function ltgUiKick() {
    var now = Date.now();
    if (now - ltgUiTs < 1000) return;
    ltgUiTs = now;
    schedRender(); if (S.layer === 'sat') satUpdateChip();
  }
  /* ── Приём удара: decode → поправки latc/lonc → фильтр по видимой области +15% ── */
  function ltgOnMsg(raw) {
    var d;
    try { d = JSON.parse(String(raw)); }
    catch (e) { try { d = JSON.parse(ltgLzwDecode(String(raw))); } catch (e2) { return; } }
    if (!d || typeof d !== 'object') return;
    if ('timeout' in d) { ltgUiKick(); return; } /* служебное «молчание» — не ошибка */
    if (!('lat' in d) || !('lon' in d) || !('time' in d)) return;
    var lat = +d.lat + (+d.latc || 0), lon = +d.lon + (+d.lonc || 0);
    /* time приходит в НАНОсекундах unix; страхуемся от мс/с */
    var tSec = d.time > 1e15 ? d.time / 1e9 : (d.time > 1e12 ? d.time / 1000 : +d.time);
    ltg.lastAt = Date.now(); ltg.err = null;
    var b = map.getBounds().pad(0.15); /* +15% за краями — удары появляются «заранее» */
    if (lat < b.getSouth() || lat > b.getNorth() || lon < b.getWest() || lon > b.getEast()) return;
    ltg.strikes.push([lat, lon, tSec, +d.delay || 0]);
    if (ltg.strikes.length > LTG_MAX) ltg.strikes.splice(0, ltg.strikes.length - LTG_MAX);
    ltgRingAdd(lat, lon);
    drawLtg(); ltgUiKick();
  }
  /* ── Жизненный цикл WS: открытие, вежливое закрытие, reconnect с backoff ── */
  function ltgWsOpen() {
    if (!ltg.on || ltg.ws) return;
    var url = LTG_WS_SERVERS[ltgWsIdx % LTG_WS_SERVERS.length];
    var ws;
    try { ws = new WebSocket(url); } catch (e) { ltgWsRetry(); return; }
    ltg.ws = ws;
    ws.onopen = function() {
      ltg.wsTry = 0; ltg.err = null;
      try { ws.send('{"a":111}'); } catch (e) {} /* приветствие протокола Blitzortung */
      schedRender(); if (S.layer === 'sat') satUpdateChip();
    };
    ws.onmessage = function(evt) { ltgOnMsg(evt.data); };
    ws.onerror = function() { /* детали придут в onclose */ };
    ws.onclose = function() {
      if (ltg.ws !== ws) return; /* уже заменён/закрыт нами */
      ltg.ws = null;
      if (ltg.on && document.visibilityState !== 'hidden') ltgWsRetry();
    };
  }
  function ltgWsRetry() {
    clearTimeout(ltg.wsTmr);
    ltg.wsTry++;
    ltgWsIdx++; /* следующая попытка — другой сервер пула */
    /* Экспоненциальный backoff: 1с → 2с → 4с → … → 30с */
    var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(ltg.wsTry - 1, 5)));
    if (ltg.wsTry >= 4) { /* ~30с без связи — честный статус, тост с троттлингом */
      ltg.err = 'нет соединения';
      if (Date.now() - ltgErrToastTs > 60000) { ltgErrToastTs = Date.now(); toast('⚡ Молнии: нет соединения, переподключаюсь…'); }
      schedRender(); if (S.layer === 'sat') satUpdateChip();
    }
    ltg.wsTmr = setTimeout(function() { if (ltg.on) ltgWsOpen(); }, delay);
  }
  function ltgWsClose() {
    clearTimeout(ltg.wsTmr); ltg.wsTmr = null;
    var ws = ltg.ws; ltg.ws = null;
    if (ws) {
      try { if (ws.readyState === 1) ws.send('{"send":false}'); } catch (e) {} /* вежливое прощание (как в официальном клиенте) */
      try { ws.onclose = null; ws.close(); } catch (e) {}
    }
  }
  function setLtg(on, silent) {
    ltg.on = !!on;
    var btn = $('btn-ltg'); if (btn) btn.classList.toggle('on', ltg.on);
    if (ltg.on) {
      ltg.wsTry = 0; ltg.err = null;
      ltgWsOpen();
      if (!silent) toast('⚡ Грозопеленгатор включён (Blitzortung, real-time)');
    } else {
      ltgWsClose();
      ltg.strikes = []; ltg.err = null; ltgRings = []; drawLtg();
      if (!silent) toast('⚡ Грозопеленгатор выключен');
    }
    buildLegend(); schedRender(); if (S.layer === 'sat') satUpdateChip();
    saveViewDebounced();
  }
  /* Скрытая вкладка: соединение закрываем (экономим трафик серверу и себе), при возврате — заново */
  document.addEventListener('visibilitychange', function() {
    if (!ltg.on) return;
    if (document.visibilityState === 'hidden') ltgWsClose();
    else { ltg.wsTry = 0; ltgWsOpen(); }
  });
  map.on('move', drawLtg); map.on('zoomend', drawLtg);
  if ($('btn-ltg')) $('btn-ltg').addEventListener('click', function() { setLtg(!ltg.on); });
  resizeLtgCanvas();

  /* ═══ БЛОК C: фоновый прогрев ВСЕХ слоёв (обобщение прежнего satPrefetch) ═══
     Способ: невидимые WMS-слои (opacity:0) ПО ОЧЕРЕДИ — один за раз, пул ≤6 общий,
     префетч-тайлы идут с пониженным приоритетом (pri 1 в satQueue) и не голодят
     активный слой. Кэш оригиналов пишет универсальный хук в SatWMS.createTile →
     satTileCache (LRU по URL: слой+TIME — ключи не пересекаются).
     НЕЗАМЕТНОСТЬ: nowcast-префетч-слоям НЕ вешаем attach*Events (чип/pulse/тосты
     не трогаются); у спутника attachSatEvents сам фильтрует шум (lyr !== eumetsatLayer).
     Прогреваем только LIVE-кадр видимой области; активный слой пропускаем.
     Это сеть, не анимация — reduce-motion прогрев НЕ отключает. */
  var prefetchCur = null, prefetchTmr = null, prefetchQueue = [];
  function prefetchNcParams(layers) {
    return { layers: layers, format: 'image/png', transparent: true, version: '1.1.1',
      crs: L.CRS.EPSG4326, tileSize: 256, zIndex: 1, maxZoom: 10, updateWhenIdle: true,
      keepBuffer: 0, opacity: 0, prefetch: true }; /* prefetch:true → пониженный приоритет пула */
  }
  function prefetchTargets() {
    var t = [];
    /* Порядок = приоритет; активный слой не прогреваем (он и так на карте) */
    if (!radarNcActive()) t.push({ nc: RADAR_NC_LAYERS[radarNcIdx].id });                       /* радар 4x4 */
    if (!(S.layer === 'wx' && radarSource === 'nowcast')) WX_NC_LAYERS.forEach(function(st) { t.push({ nc: st.id }); }); /* ОЯ: все станции */
    if (S.layer !== 'dop') t.push({ nc: DOP_HEIGHTS[dopHeightIdx].id });                        /* доплер (текущая высота) */
    if (!(prodActive() && satProduct === 'composite')) t.push({ nc: COMPOSITE_REGIONS[compositeRegionIdx].id });
    if (!(prodActive() && satProduct === 'height')) t.push({ nc: HEIGHT_NC_LAYERS });           /* высота ВГО */
    if (!(S.layer === 'sat' && !satProduct)) t.push({ sat: true });                             /* спутник (текущий канал) */
    return t;
  }
  function prefetchCancel() {
    clearTimeout(prefetchTmr); prefetchTmr = null; prefetchQueue = [];
    if (prefetchCur) { if (map.hasLayer(prefetchCur)) map.removeLayer(prefetchCur); prefetchCur = null; }
  }
  function prefetchStep() {
    if (document.visibilityState === 'hidden') { prefetchCancel(); return; }
    if (prefetchCur) return; /* уже греется — следующий встанет по done */
    var tgt = prefetchQueue.shift();
    if (!tgt) return;
    var lyr;
    if (tgt.sat) {
      lyr = createEumetsatLayer(0, SAT_CHANNELS[satChIdx], null);
      lyr.options.prefetch = true;
      attachSatEvents(lyr); /* кэш+реколоризация спутника; шумные ветки отфильтрованы */
    } else {
      lyr = new SatWMS('/api/nowcastProxy', prefetchNcParams(tgt.nc)); /* БЕЗ attach*: тихо */
    }
    lyr.addTo(map);
    prefetchCur = lyr;
    var done = function() {
      if (prefetchCur !== lyr) return;
      if (map.hasLayer(lyr)) map.removeLayer(lyr);
      prefetchCur = null;
      prefetchTmr = setTimeout(prefetchStep, 400); /* пауза между слоями — пул дышит */
    };
    lyr.once('load', function() { setTimeout(done, 500); }); /* тайлы в кэше — слой не нужен */
    setTimeout(done, 20000); /* страховка при ошибках сети */
  }
  function prefetchSchedule(delay) {
    clearTimeout(prefetchTmr);
    prefetchTmr = setTimeout(function() {
      prefetchQueue = prefetchTargets();
      if (!prefetchCur) prefetchStep();
    }, delay);
  }
  /* Совместимость: точки вызова старого satPrefetch (setLayer и т.п.) */
  function satPrefetchCancel() { prefetchCancel(); prefetchSchedule(6000); /* активный слой сменился — пересобрать список */ }
  /* Старт через ~3с (не мешаем первичному показу), после перемещений — idle 4с,
     каждые 5 мин — освежаем LIVE-кадры всех слоёв в кэше */
  setTimeout(function() { prefetchSchedule(3000); }, 0);
  map.on('moveend', function() { prefetchSchedule(4000); });
  setInterval(function() { if (document.visibilityState !== 'hidden') prefetchSchedule(0); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') prefetchCancel();
    else prefetchSchedule(2500);
  });

  /* ═══ БЛОК D: «Доплер» — ТОЛЬКО радиальная скорость ДМРЛ (nowcast.ru).
     Модельный контур Open-Meteo удалён: доплер обязан показывать реальные
     радарные данные; при недоступности nowcast — честная ошибка в чипе,
     без подмены модельным ветром. ═══ */
  var dop = { on: false };
  try { localStorage.removeItem('dopSource'); } catch (e) {} /* чистим ключ удалённого переключателя */
  function dopUpdateChip() {
    var hh = ' · ' + DOP_HEIGHTS[dopHeightIdx].label;
    var live = S.ts >= nowTs();
    var tstr = new Date((live ? nowTs() : S.ts) * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    setChip('🌀 Доплер ДМРЛ (4x4)' + hh + ' · ' + tstr + ' МСК' + (live ? ' (LIVE)' : '') + (nowcastLoading ? ' · ⏳' : '') + (nowcastErr ? ' · ⚠️ ' + nowcastErr : '') + ltgChipSuffix());
  }

  /* ═══ Настоящий доплер: WMS nowcast.ru через /api/nowcastProxy ═══
     Класс слоя ПЕРЕИСПОЛЬЗУЕМ: SatWMS не привязан к EUMETSAT — его createTile
     работает с общим пулом satQueue (≤6) и LRU-кэшем satTileCache по полному URL
     (URL содержит и слой bufr_vel*, и TIME → ключи не пересекаются со спутником).
     Ноль дублирования кода тайлов. */
  var DOP_HEIGHTS = [
    { id: 'bufr_vel1', label: '1 км' },
    { id: 'bufr_vel2', label: '2 км' },
    { id: 'bufr_vel3', label: '3 км' },
    { id: 'bufr_vel4', label: '4 км' }
  ];
  var dopHeightIdx = 0;
  var nowcastLayer = null, nowcastOld = null, nowcastLoading = false, nowcastErr = null, nowcastFails = 0, nowcastSwapTmr = null;

  function createNowcastLayer(ts) {
    var params = {
      layers: DOP_HEIGHTS[dopHeightIdx].id,
      format: 'image/png',
      transparent: true,
      version: '1.1.1',            /* проверено диагностикой: nowcast принимает 1.1.1 + SRS */
      crs: L.CRS.EPSG4326,         /* GetMap проверен именно в EPSG:4326 */
      tileSize: 256,
      zIndex: 12,
      maxZoom: 10,
      updateWhenIdle: false,
      keepBuffer: 2,
      opacity: 0.85
    };
    if (ts) params.time = satIso(ts); /* LIVE — без TIME, сервер отдаст последний кадр */
    return new SatWMS('/api/nowcastProxy', params);
  }
  var dopRecolorCache = new Map(), DOP_RECOLOR_MAX = 180;
  function dopDisplayColor(v) {
    var idx = Math.round((Math.max(-50, Math.min(50, v)) + 50) / 5);
    return DOP_DISPLAY_PALETTE[idx][1];
  }
  function recolorDopTile(tile) {
    if (!tile || tile._dopRecolored || !tile._satUrl) return;
    var hit = dopRecolorCache.get(tile._satUrl);
    if (hit) { tile._dopRecolored = true; tile.src = hit; return; }
    enqueueTile({ run: function() {
      try {
        if (tile._satAborted || tile._dopRecolored) return;
        var c = document.createElement('canvas'); c.width = c.height = 256;
        var cc = c.getContext('2d'); cc.drawImage(tile, 0, 0, 256, 256);
        var image = cc.getImageData(0, 0, 256, 256), d = image.data;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 20) continue;
          var best = null, bd = Infinity;
          for (var j = 0; j < DOP_NC_RGB.length; j++) {
            var src = DOP_NC_RGB[j], dr = d[i] - src[0], dg = d[i + 1] - src[1], db = d[i + 2] - src[2];
            var dist = dr * dr + dg * dg + db * db;
            if (dist < bd) { bd = dist; best = src; }
          }
          if (!best || bd > 6500) continue;
          if (best[3] === null) { d[i + 3] = 0; continue; }
          var col = dopDisplayColor(best[3]);
          d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2];
        }
        cc.putImageData(image, 0, 0);
        var url = c.toDataURL('image/png');
        if (dopRecolorCache.size >= DOP_RECOLOR_MAX) dopRecolorCache.delete(dopRecolorCache.keys().next().value);
        dopRecolorCache.set(tile._satUrl, url);
        tile._dopRecolored = true; tile.src = url;
      } catch (e) { /* исходный тайл остаётся видимым */ }
    } });
  }

  function attachNowcastEvents(lyr) {
    lyr.on('loading', function() { if (lyr === nowcastLayer) { nowcastLoading = true; $('pulse').classList.add('busy'); dopUpdateChip(); } });
    lyr.on('load', function() { if (lyr === nowcastLayer) { nowcastLoading = false; nowcastFails = 0; nowcastErr = null; $('pulse').classList.remove('busy'); dopUpdateChip(); if (crosshairMode) updateCrosshair(); } });
    /* Каждый тайл переводится в единую шкалу −50…+50 с шагом 5 м/с. */
    lyr.on('tileload', function(e) { if (lyr === nowcastLayer) { recolorDopTile(e.tile); if (crosshairMode) updateCrosshair(); } });
    lyr.on('tileerror', function() {
      if (lyr !== nowcastLayer) return;
      nowcastFails++;
      if (nowcastFails >= 6) {
        /* Модельного fallback больше нет: показываем честную ошибку. */
        nowcastErr = '4x4 недоступен — нажмите ↻';
        nowcastLoading = false; $('pulse').classList.remove('busy'); dopUpdateChip();
        if (Date.now() - satErrToastTs > 30000) { satErrToastTs = Date.now(); toast('⚠️ Доплер (4x4) недоступен'); }
      } else if (nowcastFails >= 3) {
        nowcastErr = 'ошибки тайлов'; nowcastLoading = false; $('pulse').classList.remove('busy'); dopUpdateChip();
      }
    });
  }
  /* Смена кадра/высоты: новый слой поверх, старый снимаем после загрузки (как satApplyTime) */
  function nowcastApplyTime(immediate) {
    if (S.layer !== 'dop') return;
    clearTimeout(nowcastSwapTmr);
    nowcastSwapTmr = setTimeout(function() {
      if (S.layer !== 'dop') return;
      var live = S.ts >= nowTs();
      var old = nowcastLayer;
      if (nowcastOld && map.hasLayer(nowcastOld)) { map.removeLayer(nowcastOld); nowcastOld = null; }
      var lyr = createNowcastLayer(live ? null : S.ts);
      attachNowcastEvents(lyr);
      lyr.addTo(map);
      nowcastLayer = lyr;
      if (old) {
        nowcastOld = old;
        var rm = function() { if (nowcastOld === old && map.hasLayer(old)) { map.removeLayer(old); nowcastOld = null; } };
        lyr.once('load', rm);
        setTimeout(rm, 5000);
      }
      dopUpdateChip();
    }, immediate ? 0 : 180);
  }
  function nowcastRemove() {
    clearTimeout(nowcastSwapTmr);
    if (nowcastLayer) { if (map.hasLayer(nowcastLayer)) map.removeLayer(nowcastLayer); nowcastLayer = null; }
    if (nowcastOld) { if (map.hasLayer(nowcastOld)) map.removeLayer(nowcastOld); nowcastOld = null; }
    nowcastLoading = false; nowcastErr = null; nowcastFails = 0;
  }
  function setDopHeight(idx) {
    if (idx < 0 || idx >= DOP_HEIGHTS.length || idx === dopHeightIdx) return;
    dopHeightIdx = idx;
    document.querySelectorAll('#dopheight-dropdown .dd-item').forEach(function(it, i) { it.classList.toggle('active', i === idx); });
    var b = $('btn-dopheight'); if (b) b.textContent = 'Высота: ' + DOP_HEIGHTS[idx].label;
    if (dop.on) nowcastApplyTime(true);
    toast('🌀 Радиальная скорость на ' + DOP_HEIGHTS[idx].label);
  }

  function dopStart() {
    if (dop.on) return;
    dop.on = true;
    var hw = $('dopheight-wrapper'); if (hw) hw.style.display = 'block';
    nowcastFails = 0; nowcastApplyTime(true);
  }
  function dopStop() {
    if (!dop.on) return;
    dop.on = false;
    nowcastRemove();
    var hw = $('dopheight-wrapper'); if (hw) hw.style.display = 'none';
  }
  /* Дропдаун высоты радиальной скорости (1–4 км) */
  (function initDopHeightUI() {
    var dd = $('dopheight-dropdown'), btn = $('btn-dopheight');
    if (!dd || !btn) return;
    DOP_HEIGHTS.forEach(function(h, i) {
      var item = document.createElement('div');
      item.className = 'dd-item' + (i === dopHeightIdx ? ' active' : '');
      item.setAttribute('tabindex', '0'); item.setAttribute('role', 'button');
      item.textContent = 'Радиальная скорость · ' + h.label;
      item.addEventListener('click', function() { setDopHeight(i); dd.classList.remove('visible'); });
      item.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDopHeight(i); dd.classList.remove('visible'); btn.focus(); } });
      dd.appendChild(item);
    });
    btn.addEventListener('click', function(e) { e.stopPropagation(); dd.classList.toggle('visible'); });
    document.addEventListener('click', function(e) { if (!$('dopheight-wrapper').contains(e.target)) dd.classList.remove('visible'); });
  })();

  /* ═══ БЛОК A: радар dBZ с nowcast.ru (основной источник) ═══
     Слой — тот же переиспользуемый SatWMS через /api/nowcastProxy (пул ≤6,
     LRU-кэш по полному URL: имя слоя (bufr_dbz1 или fmi) + TIME → ключи не
     пересекаются ни со спутником, ни с доплером). Канвас #radar здесь не используется. */
  var radarNcLayer = null, radarNcOld = null, radarNcSwapTmr = null;
  var radarNcLoading = false, radarNcErr = null, radarNcFails = 0;
  /* Единый nowcast-режим для dBZ И ОЯ: один переключатель источника, один fallback */
  function radarNcActive() { return (S.layer === 'radar' || S.layer === 'wx') && radarSource === 'nowcast'; }
  function createRadarNcLayer(ts) {
    var params = {
      /* ОЯ Явления — первая станция BUFR (остальные — wxNcExtras); отражаемость — выбранные данные (ДМРЛ/FMI) */
      layers: S.layer === 'wx' ? WX_NC_LAYERS[0].id : RADAR_NC_LAYERS[radarNcIdx].id,
      format: 'image/png',
      transparent: true,
      version: '1.1.1',
      crs: L.CRS.EPSG4326,   /* проверенная комбинация nowcast (как у доплера) */
      tileSize: 256,
      zIndex: 11,
      maxZoom: 10,
      updateWhenIdle: false,
      keepBuffer: 2,
      /* прозрачность — из слайдера; скрытый dBZ (👁) = opacity 0 */
      opacity: S.dbzVisible ? (parseInt($('opacity-slider').value) || 100) / 100 : 0
    };
    if (ts) params.time = satIso(ts); /* LIVE — без TIME */
    return new SatWMS('/api/nowcastProxy', params);
  }

  /* Реколоризация под кастомную палитру: nowcast-цвета совпадают с BUILTIN_RADAR →
     обратное сопоставление цвет→dBZ (nearest, как findPalEntry), затем пороги
     активной палитры. Стандартная палитра — тайлы как есть, без работы. */
  var radarRecolorCache = new Map(), RADAR_RECOLOR_MAX = 150;
  function radarPalIsDefault() { return palettes.radar.activeIdx === 0; }
  function recolorRadarNcTile(tile) {
    if (S.layer !== 'radar') return; /* у явлений nowcast своя раскраска — не перекрашиваем */
    if (radarPalIsDefault()) return;
    var pal = palettes.radar.list[palettes.radar.activeIdx];
    if (!pal || !pal.items || !pal.items.length) return;
    var key = tile._satUrl + '\u00a7rad\u00a7' + satPalSignature(pal);
    var hit = radarRecolorCache.get(key);
    if (hit) { enqueueTile({ run: function() { if (!tile._satAborted) { tile._recolored = true; tile.src = hit; } } }); return; }
    var items = pal.items;
    enqueueTile({ run: function() {
      try {
        if (tile._satAborted) return;
        var c = document.createElement('canvas'); c.width = c.height = 256;
        var cc = c.getContext('2d');
        cc.drawImage(tile, 0, 0, 256, 256);
        var idd = cc.getImageData(0, 0, 256, 256), d = idd.data;
        for (var i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          /* цвет → dBZ по таблице BUILTIN_RADAR (nearest, порог расстояния) */
          var best = -1, bd = 1e9;
          for (var j = 0; j < BUILTIN_RADAR.length; j++) {
            var e = BUILTIN_RADAR[j];
            var dr = d[i] - e.r[0], dg = d[i + 1] - e.r[1], db = d[i + 2] - e.r[2];
            var dist = dr * dr + dg * dg + db * db;
            if (dist < bd) { bd = dist; best = j; }
          }
          if (best < 0 || bd > 4000) continue; /* чужой цвет (подписи и т.п.) — не трогаем */
          var v = BUILTIN_RADAR[best].v, col = null;
          for (var k = 0; k < items.length; k++) { if (v >= items[k].v) { col = items[k].r; break; } }
          if (col) { d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; }
          else { d[i + 3] = 0; } /* ниже минимального порога палитры — прозрачно */
        }
        cc.putImageData(idd, 0, 0);
        var du = c.toDataURL();
        if (radarRecolorCache.size >= RADAR_RECOLOR_MAX) radarRecolorCache.delete(radarRecolorCache.keys().next().value);
        radarRecolorCache.set(key, du);
        tile._recolored = true;
        tile.src = du;
      } catch (err) { /* tainted невозможен (свой домен), но страхуемся */ }
    } });
  }

  function attachRadarNcEvents(lyr) {
    lyr.on('loading', function() { if (lyr === radarNcLayer) { radarNcLoading = true; $('pulse').classList.add('busy'); schedRender(); } });
    lyr.on('load', function() { if (lyr === radarNcLayer) { radarNcLoading = false; radarNcFails = 0; radarNcErr = null; $('pulse').classList.remove('busy'); schedRender(); if (crosshairMode) updateCrosshair(); } });
    lyr.on('tileload', function(e) { if (lyr === radarNcLayer && !e.tile._recolored) recolorRadarNcTile(e.tile); if (lyr === radarNcLayer && crosshairMode) updateCrosshair(); });
    lyr.on('tileerror', function() {
      if (lyr !== radarNcLayer) return;
      radarNcCountFail();
    });
  }
  /* Общий счётчик ошибок nowcast (главный слой + доп. станции ОЯ) → общий fallback */
  function radarNcCountFail() {
    radarNcFails++;
    if (radarNcFails >= 6 && radarSource === 'nowcast') {
      /* БЛОК B: авто-fallback на rainradar. Авто-возврата НЕТ — периодические
         пробные запросы дёргали бы полуживой сервер и мигали слоем;
         возврат — вручную кнопкой «Источник» в легенде. */
      toast('⚠️ ДМРЛ (4x4) недоступен — переключаюсь на rainradar');
      setRadarSource('rainradar', true);
    } else if (radarNcFails >= 3) {
      radarNcErr = 'ошибки тайлов'; radarNcLoading = false; $('pulse').classList.remove('busy'); schedRender();
    }
  }
  /* ─── БЛОК A: доп. станции ОЯ BUFR (все, кроме первой — её ведёт radarNcLayer).
     Каждая станция — отдельный прозрачный WMS-слой с тем же zIndex: географии
     не пересекаются, наложение корректно. Свап по паттерну проекта: новые поверх,
     старые убираем после загрузки (страховка 5с). ─── */
  var wxNcExtras = [], wxNcExtrasOld = [];
  function wxNcClearExtras() {
    wxNcExtras.concat(wxNcExtrasOld).forEach(function(l) { if (map.hasLayer(l)) map.removeLayer(l); });
    wxNcExtras = []; wxNcExtrasOld = [];
  }
  function wxNcSyncExtras(ts) {
    /* вызывается из radarNcApply: не-ОЯ режим → просто убрать доп. станции */
    if (S.layer !== 'wx' || radarSource !== 'nowcast') { wxNcClearExtras(); return; }
    wxNcExtrasOld = wxNcExtrasOld.concat(wxNcExtras);
    wxNcExtras = [];
    for (var i = 1; i < WX_NC_LAYERS.length; i++) {
      var params = {
        layers: WX_NC_LAYERS[i].id,
        format: 'image/png', transparent: true, version: '1.1.1',
        crs: L.CRS.EPSG4326, tileSize: 256, zIndex: 11, maxZoom: 10,
        updateWhenIdle: false, keepBuffer: 2,
        opacity: S.dbzVisible ? (parseInt($('opacity-slider').value) || 100) / 100 : 0
      };
      if (ts) params.time = satIso(ts); /* LIVE — без TIME, общий кадр с главным слоем */
      var lyr = new SatWMS('/api/nowcastProxy', params);
      lyr.on('tileerror', radarNcCountFail); /* общий счётчик → общий fallback на rainradar */
      lyr.addTo(map);
      wxNcExtras.push(lyr);
    }
    var rmOld = function() {
      wxNcExtrasOld.forEach(function(l) { if (map.hasLayer(l)) map.removeLayer(l); });
      wxNcExtrasOld = [];
    };
    if (wxNcExtras.length) wxNcExtras[0].once('load', rmOld);
    setTimeout(rmOld, 5000);
  }
  /* Смена кадра/данных: новый слой поверх, старый после загрузки (единый паттерн проекта) */
  function radarNcApply(immediate) {
    if (!radarNcActive()) return;
    clearTimeout(radarNcSwapTmr);
    radarNcSwapTmr = setTimeout(function() {
      if (!radarNcActive()) return;
      var live = S.ts >= nowTs();
      var old = radarNcLayer;
      if (radarNcOld && map.hasLayer(radarNcOld)) { map.removeLayer(radarNcOld); radarNcOld = null; }
      var lyr = createRadarNcLayer(live ? null : S.ts);
      attachRadarNcEvents(lyr);
      lyr.addTo(map);
      radarNcLayer = lyr;
      wxNcSyncExtras(live ? null : S.ts); /* ОЯ: пересоздать слои остальных станций с тем же кадром */
      if (old) {
        radarNcOld = old;
        var rm = function() { if (radarNcOld === old && map.hasLayer(old)) { map.removeLayer(old); radarNcOld = null; } };
        lyr.once('load', rm);
        setTimeout(rm, 5000);
      }
      schedRender();
    }, immediate ? 0 : 180);
  }
  function radarNcRemove() {
    clearTimeout(radarNcSwapTmr);
    if (radarNcLayer) { if (map.hasLayer(radarNcLayer)) map.removeLayer(radarNcLayer); radarNcLayer = null; }
    if (radarNcOld) { if (map.hasLayer(radarNcOld)) map.removeLayer(radarNcOld); radarNcOld = null; }
    wxNcClearExtras(); /* доп. станции ОЯ убираем вместе с главным слоем */
    radarNcLoading = false; radarNcErr = null; radarNcFails = 0;
  }
  function setRadarSource(src, auto) {
    radarSource = src;
    radarSourceAuto = !!auto && src === 'rainradar';
    try { localStorage.setItem('radarSource', src); } catch (e) {}
    if (S.layer !== 'radar' && S.layer !== 'wx') { buildLegend(); return; }
    if (src === 'nowcast') {
      radarNcFails = 0; radarNcErr = null;
      fadeCanvas(false); /* канвас не нужен — рисует WMS-слой */
      radarNcApply(true);
      if (!auto) toast((S.layer === 'wx' ? 'Явления' : 'Радар') + ': 4x4 (ДМРЛ)');
    } else {
      radarNcRemove();
      fadeCanvas(true); /* обратно на канвас rainradar */
      S.cache.clear(); S.pending.clear(); S.failed.clear();
      schedRender();
      if (!auto) toast((S.layer === 'wx' ? 'Явления' : 'Радар') + ': rainradar.ru');
    }
    buildLegend(); schedRender();
  }
  function setRadarNcData(idx) {    if (idx < 0 || idx >= RADAR_NC_LAYERS.length || idx === radarNcIdx) return;
    radarNcIdx = idx;
    try { localStorage.setItem('radarNcLayer', RADAR_NC_LAYERS[idx].id); } catch (e) {}
    if (radarNcActive()) radarNcApply(true);
    buildLegend();
    toast('Данные: ' + RADAR_NC_LAYERS[idx].label);
  }
  /* ─── БЛОК B: самолечение 4x4-слоёв. Если тайлы падали (retry исчерпаны — Leaflet
     оставляет «дыры» до смены кадра), раз в 20с пересоздаём слой: закэшированные
     тайлы вернутся мгновенно из satTileCache, упавшие — запросятся заново.
     Failed НЕ вечен (в отличие от спутника с историей — тут LIVE-данные). ─── */
  setInterval(function() {
    if (document.visibilityState === 'hidden') return;
    if (radarNcActive() && radarNcErr && !S.playing) { radarNcErr = null; radarNcFails = 0; radarNcApply(true); }
    if (S.layer === 'dop' && nowcastErr && !S.playing) { nowcastErr = null; nowcastFails = 0; nowcastApplyTime(true); }
    if (prodActive() && prodDef().kind === 'wms' && prodWmsErr) { prodWmsErr = false; prodWmsApply(true); }
  }, 20000);
  /* ─── БЛОК B: авто-возврат на 4x4 после авто-fallback на rainradar.
     Раз в 5 мин — один дешёвый пробный запрос LIVE-тайла; вернёмся только при успехе
     (полуживой сервер не дёргаем чаще). ─── */
  setInterval(function() {
    if (!radarSourceAuto || document.visibilityState === 'hidden') return;
    if (S.layer !== 'radar' && S.layer !== 'wx') return;
    fetch('/api/nowcastProxy?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=bufr_dbz1&SRS=EPSG:4326&BBOX=35,53,41,58&WIDTH=64&HEIGHT=64&FORMAT=image%2Fpng&TRANSPARENT=true', { cache: 'no-store' })
      .then(function(r) { if (r.ok && radarSourceAuto) { toast('✅ 4x4 снова доступен — возвращаюсь'); setRadarSource('nowcast', false); } })
      .catch(function() { /* всё ещё лежит — остаёмся на rainradar */ });
  }, 5 * 60 * 1000);
  /* Возврат на вкладку: LIVE-кадр мог устареть — обновляем сразу */
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && radarNcActive() && !S.playing && !S.manualTime) {
      var n = nowTs();
      if (n !== S.ts) { S.ts = n; updHUD(); }
      radarNcApply(true);
    }
  });
  function forceRefresh() {
    if (S.layer === 'sat') { satRecolorCache.clear(); satApplyTime(true); return; } /* смена палитры спутника → перекрасить тайлы */
    if (radarNcActive()) { radarRecolorCache.clear(); radarNcApply(true); return; } /* nowcast-радар: пересоздать слой (палитра/кадр) */
    S.cache.clear(); S.failed.clear(); S.pending.clear(); S.loadN = 0; $('pulse').classList.remove('busy'); schedRender();
  }
  /* Вращение иконки ↻ — видимый статус обновления */
  function spinRefreshBtn() { var b = $('btn-refresh'); retrig(b, 'spinning'); setTimeout(function() { b.classList.remove('spinning'); }, 850); }
  function doRefresh() { 
    spinRefreshBtn();
    if (S.layer === 'sat') { 
      /* Пересоздаём слой с сохранением выбранного канала и времени кадра */
      satErrToastTs = 0;
      satApplyTime(true);
      if (prodGridActive()) fetchProdGrid(true); /* сетка продукта — принудительный рефетч */
      buildFrames(); updHUD();
      toast(satProduct ? 'Продукт обновлён' : 'Спутник обновлён'); 
      return; 
    }
    if (ltg.on && (!ltg.ws || ltg.ws.readyState !== 1)) { ltg.wsTry = 0; ltgWsClose(); ltgWsOpen(); } /* ↻ пересоединяет молнии, если WS упал */
    if (S.layer === 'dop') { /* ↻ доплера: свежий LIVE-кадр nowcast или пересчёт модели */
      setTime(nowTs(), false); buildFrames(); updHUD(); nowcastFails = 0; nowcastErr = null; nowcastApplyTime(true);
      toast('Доплер обновлён');
      return;
    }
    setTime(nowTs(), false); startFrameFade(); buildFrames(); updHUD(); forceRefresh(); toast('Обновлено'); 
  }
  function updHUD() { updThumb(); }
  /* Прогресс и thumb — через transform (scaleX/translateX), а не left/width: без layout-перерасчётов */
  function updThumb() { var f = S.frames; if (!f.length) return; var r = f[f.length - 1] - f[0], p = r === 0 ? 0 : Math.max(0, Math.min(1, (S.ts - f[0]) / r)); var tw = $('track').offsetWidth; $('tfill').style.transform = 'scaleX(' + p + ')'; $('tthumb').style.transform = 'translate(' + (p * tw) + 'px, -50%) translateX(-50%)'; }
  function buildFrames() {
    /* Работает для радара И спутника: сетка времени задаётся stepSec()/histSec() */
    var mx = nowTs(), from = mx - histSec(), frames = [];
    for (var t = from; t <= mx; t += stepSec()) frames.push(t);
    S.frames = frames;
    buildFramesUI();
  }
  function buildFramesUI() {
    var el = $('tlbls'); el.innerHTML = '';
    if (!S.frames.length) return;
    for (var i = 0; i < 5; i++) {
      var idx = Math.round(i / 4 * (S.frames.length - 1));
      if (idx >= S.frames.length) idx = S.frames.length - 1;
      var s = document.createElement('span');
      s.textContent = new Date(S.frames[idx] * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
      el.appendChild(s);
    }
    updThumb();
  }

  var drag = false, timeTooltip = $('time-tooltip');
  function tsFromX(cx) { var r = $('track').getBoundingClientRect(); var p = Math.max(0, Math.min(1, (cx - r.left) / r.width)); return S.frames[Math.round(p * (S.frames.length - 1))] || nowTs(); }
  function pctFromX(cx) { var r = $('track').getBoundingClientRect(); return Math.max(0, Math.min(1, (cx - r.left) / r.width)) * 100; }
  function formatTimeDiff(ts) { var now = nowTs(), diff = ts - now, ad = Math.abs(diff); if (ad < 60) return { text: 'сейчас', cls: 'now' }; var mins = Math.round(ad / 60), hours = Math.floor(mins / 60), rm = mins % 60, text = ''; if (hours > 0) { text = hours + 'ч'; if (rm > 0) text += ' ' + rm + 'м'; } else text = mins + 'м'; return diff < 0 ? { text: '−' + text + ' назад', cls: 'past' } : { text: '+' + text + ' вперёд', cls: 'future' }; }
  function showTimeTooltip(ts, pct) { var d = new Date(ts * 1000), ts2 = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Moscow' }), ds = d.toLocaleDateString('ru', { day: '2-digit', month: 'short', timeZone: 'Europe/Moscow' }), di = formatTimeDiff(ts); timeTooltip.innerHTML = '<div class="tt-time">' + ts2 + '</div><div class="tt-date">' + ds + ' МСК</div><div class="tt-diff ' + di.cls + '">' + di.text + '</div>'; timeTooltip.style.left = pct + '%'; timeTooltip.classList.add('visible'); }
  function hideTimeTooltip() { timeTooltip.classList.remove('visible'); }
  $('track').addEventListener('pointerdown', function(e) { drag = true; this.classList.add('dragging'); var ts = tsFromX(e.clientX), pct = pctFromX(e.clientX); S.ts = ts; updHUD(); S.manualTime = true; schedRender(); showTimeTooltip(ts, pct); this.setPointerCapture(e.pointerId); });
  $('track').addEventListener('pointermove', function(e) { if (drag) { var ts = tsFromX(e.clientX), pct = pctFromX(e.clientX); S.ts = ts; updHUD(); schedRender(); showTimeTooltip(ts, pct); if (S.layer === 'sat') satApplyTime(); } });
  document.addEventListener('pointerup', function() { if (drag) { drag = false; $('track').classList.remove('dragging'); hideTimeTooltip(); if (S.layer === 'sat') { satApplyTime(true); } else if (S.layer === 'dop') { nowcastApplyTime(true); } else { startFrameFade(); buildFrames(); S.failed.clear(); forceRefresh(); } } });
  $('track').addEventListener('mousemove', function(e) { if (!drag) showTimeTooltip(tsFromX(e.clientX), pctFromX(e.clientX)); });
  $('track').addEventListener('mouseleave', function() { if (!drag) hideTimeTooltip(); });

  /* Для спутника базовый интервал больше: каждый кадр — сетевые WMS-тайлы */
  function animMs() { return (S.layer === 'sat' ? 2000 : 900) / S.speeds[S.speedI]; }
  function togglePlay() { S.playing ? stopPlay() : startPlay(); }
  function startPlay() {
    buildFrames(); S.frameI = 0; 
    S.timer = setInterval(function() {
      S.frameI = (S.frameI + 1) % S.frames.length;
      startFrameFade(); /* crossfade между кадрами (для sat — no-op) */
      S.ts = S.frames[S.frameI];
      if (S.layer === 'sat') { satApplyTime(); } else if (S.layer === 'dop') { nowcastApplyTime(); } else if (radarNcActive()) { radarNcApply(); } else { S.failed.clear(); schedRender(); }
      updHUD();
    }, animMs());
    S.playing = true; $('playbtn').innerHTML = '&#x25A0;'; retrig($('playbtn'), 'pop');
  }
  function stopPlay() { var was = S.playing; clearInterval(S.timer); S.timer = null; S.playing = false; $('playbtn').innerHTML = '&#x25B6;'; if (was) retrig($('playbtn'), 'pop'); }
  function cycleSpeed() { S.speedI = (S.speedI + 1) % S.speeds.length; var spd = $('spd'); spd.textContent = S.speeds[S.speedI] + '×'; spd.classList.toggle('on', S.speedI > 0); retrig(spd, 'bump'); if (S.playing) { stopPlay(); startPlay(); } }
  function shiftTs(d) {
    stopPlay();
    var n = Math.round((S.ts + d) / stepSec()) * stepSec(); var mn = minTs(), mx = nowTs();
    n = Math.max(mn, Math.min(n, mx)); if (n <= mn) toast('⚠️ Максимум ' + Math.round(histSec() / 60) + ' мин назад');
    if (S.layer === 'sat') { setTime(n, true); buildFrames(); updHUD(); satApplyTime(true); }
    else if (S.layer === 'dop') { setTime(n, true); buildFrames(); updHUD(); nowcastApplyTime(true); }
    else { startFrameFade(); setTime(n, true); buildFrames(); updHUD(); S.failed.clear(); forceRefresh(); }
    toast('⏱ ' + new Date(S.ts * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }));
  }
  
  function syncTopLayerUI(layer) {
    document.querySelectorAll('#layers-dropdown .dd-item').forEach(function(item) { item.classList.toggle('active', item.dataset.layer === layer); });
    var labels = { radar: 'dBZ', wx: 'ОЯ', sat: 'Спутник', height: 'Высота ВГО', dop: 'Доплер' };
    $('btn-layers-menu').textContent = 'Слой: ' + (labels[layer] || layer);
  }

  function setLayer(newLayer) {
    if (!newLayer) return;
    /* Высота ВГО — отдельный пункт UI, внутри использует проверенный WMS-контур sat/height. */
    if (newLayer === 'height') {
      if (S.layer !== 'sat') setLayer('sat');
      if (satProduct !== 'height') setSatProduct('height');
      $('channel-wrapper').style.display = 'none';
      syncTopLayerUI('height');
      saveViewDebounced();
      return;
    }
    /* Переход «Высота ВГО → Спутник» возвращает обычный канал, а не старый продукт. */
    if (newLayer === 'sat' && S.layer === 'sat' && satProduct === 'height') {
      setSatProduct(null);
      $('channel-wrapper').style.display = 'block';
      syncTopLayerUI('sat');
      saveViewDebounced();
      return;
    }
    if (newLayer === S.layer) return;
    if (satProduct === 'height' && newLayer !== 'sat') {
      satProduct = null;
      try { localStorage.removeItem('satProduct'); } catch (e) {}
    }
    S.layer = newLayer;
    syncTopLayerUI(S.layer);

    stopPlay();
    satPrefetchCancel(); /* смена слоя: снять текущий префетч и пересобрать план прогрева */
    /* Смена слоя всегда возвращает видимость dBZ — предсказуемо для пользователя */
    S.dbzVisible = true;
    /* Уборка спец-слоёв (ДМРЛ/доплер) — идемпотентно при любом переходе */
    dopStop(); /* доплер-режим всегда сворачиваем */
    radarNcRemove(); /* nowcast-радар пересоздадим ниже, если возвращаемся на radar */
    /* Таймлайн возвращаем, если пользователь не скрывал его сам (спец-слои его прячут) */
    if (S.layer !== 'dop' && !hiddenPanels['tl']) $('tl').style.display = 'flex';
    if (S.layer === 'dop') {
      /* ─── Спец-слой «Доплер»: чистая базовая карта + WMS радиальной скорости.
         Радар-канвас и спутник выключаем; таймлайн работает (история 4x4). ─── */
      prodExit(); /* грозовой продукт (если был в sat) — убрать слой/канвас */
      if (eumetsatLayer) { map.removeLayer(eumetsatLayer); eumetsatLayer = null; }
      if (satOldLayer) { if (map.hasLayer(satOldLayer)) map.removeLayer(satOldLayer); satOldLayer = null; }
      satLoading = false; $('pulse').classList.remove('busy');
      updateSatBackdrop(false);
      $('channel-wrapper').style.display = 'none';
      $('opacity-slider').value = radarOpacityMem;
      $('opacity-val').textContent = radarOpacityMem + '%';
      fadeCanvas(false); /* canvasShouldHide() знает про спец-слои */
      /* Доплер: у 4x4 есть история (Extent) — таймлайн работает, LIVE без TIME */
      S.manualTime = false; S.ts = nowTs();
      buildFrames(); updHUD();
      dopStart();
      toast('🌀 Доплер: радиальная скорость ДМРЛ (4x4)');
      schedRender(); /* чип обновится в doRender */
      applyDbzUI();
      buildLegend(); hidePopup(); $('hover-indicator').style.display = 'none'; if (crosshairMode) requestAnimationFrame(updateCrosshair); /* прицел пересчитывается под новый слой */
      if (S.ruler.active) toggleRuler();
      saveViewDebounced();
      return;
    }
    if (S.layer === 'sat') {
      satPrefetchCancel(); /* прогрев больше не нужен — кэш уже тёплый, показываем сразу */
      /* Спутник: канвас радара плавно гаснет, таймлайн ОСТАЁТСЯ (история WMS через time=) */
      fadeCanvas(false);
      /* Прозрачность спутника фиксирована 50%: запоминаем значение радара,
         слайдер показывает 50 и блокируется (как для скрытого dBZ) */
      radarOpacityMem = parseInt($('opacity-slider').value) || 100;
      /* Слайдер работает и в sat-режиме: показываем текущее значение спутника (дефолт 50%) */
      $('opacity-slider').value = satOpacityMem;
      $('opacity-val').textContent = satOpacityMem + '%';
      $('opacity-slider').disabled = false; $('opacity-control').classList.remove('disabled');
      $('channel-wrapper').style.display = 'block';
      S.manualTime = false; S.ts = nowTs();
      buildFrames(); updHUD();
      if (satProduct) { prodEnter(); } else { satApplyTime(true); } /* сохранённый продукт восстанавливаем вместо канала */
      updateSatBackdrop(true); /* на light/scheme — тёмная подложка, иначе снимки сливаются с белой картой */
      map.invalidateSize();
      toast(satProduct ? ('Продукт: ' + prodDef().label) : ('Спутник EUMETSAT: ' + SAT_CHANNELS[satChIdx].label));
    } else {
      /* Возврат к радару: снимаем WMS-слои, канвас плавно проявляется */
      startFrameFade(); /* снимок старого слоя для crossfade (radar↔wx) */
      prodExit(); /* грозовой продукт (если был) — слой/канвас долой, satProduct сохранён */
      if (eumetsatLayer) { map.removeLayer(eumetsatLayer); eumetsatLayer = null; }
      if (satOldLayer) { if (map.hasLayer(satOldLayer)) map.removeLayer(satOldLayer); satOldLayer = null; }
      satLoading = false; $('pulse').classList.remove('busy');
      updateSatBackdrop(false); /* подложка нужна только в sat-режиме */
      $('channel-wrapper').style.display = 'none';
      /* Возвращаем прозрачность радара, какой была до входа в sat; слайдер снова активен
         (applyDbzUI ниже уточнит disabled-состояние по S.dbzVisible) */
      $('opacity-slider').value = radarOpacityMem;
      $('opacity-val').textContent = radarOpacityMem + '%';
      $('opacity-slider').disabled = false; $('opacity-control').classList.remove('disabled');
      fadeCanvas(true); /* использует значение слайдера — восстановить ДО вызова */
      S.manualTime = false; S.ts = nowTs();
      S.pxIndex = 1; S.px = S.pxLevels[S.pxIndex]; updatePxLabel();
      S.cache.clear(); S.pending.clear(); S.failed.clear();
      buildFrames();
      if (radarNcActive()) { fadeCanvas(false); radarNcApply(true); } /* dBZ/ОЯ с nowcast: канвас не нужен */
      else forceRefresh();
    }
    applyDbzUI();
    buildLegend(); hidePopup(); $('hover-indicator').style.display = 'none'; if (crosshairMode) requestAnimationFrame(updateCrosshair); /* прицел пересчитывается под новый слой */
    if (S.ruler.active) toggleRuler();
    saveViewDebounced();
  }

  /* ─── Выбор канала спутника ─── */
  function setSatChannel(idx) {
    /* клик по текущему каналу при АКТИВНОМ продукте = возврат к каналу */
    if (idx < 0 || idx >= SAT_CHANNELS.length || (idx === satChIdx && !satProduct)) { $('channel-dropdown').classList.remove('visible'); return; }
    var hadProd = !!satProduct;
    if (hadProd) setSatProduct(null); /* выбор канала выключает грозовой продукт */
    if (idx === satChIdx) { syncChannelUI(); $('channel-dropdown').classList.remove('visible'); return; }
    satChIdx = idx;
    try { localStorage.setItem('satChannel', SAT_CHANNELS[idx].id); } catch (e) {}
    var ch = SAT_CHANNELS[idx];
    $('btn-channel').textContent = 'Канал: ' + ch.label;
    syncChannelUI();
    $('channel-dropdown').classList.remove('visible');
    /* Подсказка для дневных каналов ночью (грубая оценка: 03–17 UTC ≈ светлое время для зоны MSG) */
    var utcH = new Date().getUTCHours();
    if (ch.day && (utcH < 3 || utcH > 17)) toast('☀️ Канал «' + ch.label + '» информативен только днём');
    buildLegend();
    satApplyTime(true);
    satUpdateChip();
    saveViewDebounced();
  }
  /* Подсветка активного пункта (канал ИЛИ продукт) + текст кнопки */
  function syncChannelUI() {
    document.querySelectorAll('#channel-dropdown .dd-item').forEach(function(item) {
      var pid = item.dataset.prod;
      if (pid) item.classList.toggle('active', pid === satProduct);
      else item.classList.toggle('active', !satProduct && +item.dataset.ch === satChIdx);
    });
    $('btn-channel').textContent = satProduct ? ('Продукт: ' + prodDef().label.split(' (')[0]) : ('Канал: ' + SAT_CHANNELS[satChIdx].label);
  }
  function initChannelUI() {
    var dd = $('channel-dropdown');
    SAT_CHANNELS.forEach(function(ch, i) {
      var item = document.createElement('div');
      item.className = 'dd-item' + (i === satChIdx && !satProduct ? ' active' : '');
      item.dataset.ch = i;
      item.setAttribute('tabindex', '0'); item.setAttribute('role', 'button');
      item.textContent = ch.label + (ch.day ? ' ☀️' : '');
      item.addEventListener('click', function() { setSatChannel(i); });
      item.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSatChannel(i); $('btn-channel').focus(); } });
      dd.appendChild(item);
    });
    /* В меню спутника остаются только реальные каналы EUMETSAT.
       Высота ВГО вынесена в основное меню слоёв. */
    $('btn-channel').textContent = 'Канал: ' + SAT_CHANNELS[satChIdx].label;
    $('btn-channel').addEventListener('click', function(e) { e.stopPropagation(); dd.classList.toggle('visible'); });
    document.addEventListener('click', function(e) { if (!$('channel-wrapper').contains(e.target)) dd.classList.remove('visible'); });
  }
  initChannelUI();

  function cyclePx() { if (S.layer === 'sat') return; if (radarNcActive()) { toast('Разрешение настраивается в режиме rainradar (источник — в легенде)'); return; } S.pxIndex = (S.pxIndex + 1) % S.pxLevels.length; S.px = S.pxLevels[S.pxIndex]; updatePxLabel(); S.cache.clear(); S.pending.clear(); S.failed.clear(); forceRefresh(); var resKm = (S.px * BASE_RES_KM).toFixed(1); toast('Разрешение: ' + resKm + ' км/пиксель'); schedRender(); saveViewDebounced(); }
  function updatePxLabel() { var resKm = (S.px * BASE_RES_KM); var label = resKm.toFixed(1) + ' км'; if (resKm === 1) label = '1x1 км'; if (resKm === 2) label = '2x2 км'; if (resKm === 4) label = '4x4 км'; if (resKm === 8) label = '8x8 км'; $('pxbtn').textContent = label; }
  /* Текст кнопок не меняем на «✓» — активность показывает состояние .on (без прыжков ширины) */
  function toggleSmooth() { if (S.layer === 'sat') return; if (radarNcActive()) { toast('Сглаживание доступно в режиме rainradar (источник — в легенде)'); return; } S.smooth = !S.smooth; var btn = $('btn-smooth'); var ctrl = $('smooth-control'); if (S.smooth) { btn.classList.add('on'); ctrl.classList.add('active'); } else { btn.classList.remove('on'); ctrl.classList.remove('active'); } S.cache.clear(); S.pending.clear(); S.failed.clear(); forceRefresh(); toast(S.smooth ? 'Сглаживание включено (сила ' + S.smoothStrength + ')' : 'Сглаживание выключено'); saveViewDebounced(); }

  function toggleRuler() { S.ruler.active = !S.ruler.active; var btn = $('btn-ruler'); if (S.ruler.active) { btn.classList.add('on'); toast('Клик — точка, двойной клик — завершить.'); map.on('click', rulerClick); map.on('dblclick', rulerFinish); if (crosshairMode) toggleCrosshair(); } else { btn.classList.remove('on'); map.off('click', rulerClick); map.off('dblclick', rulerFinish); clearRuler(); } }
  function rulerClick(e) { if (!S.ruler.active) return; var latlng = e.latlng; S.ruler.points.push(latlng); var marker = L.circleMarker(latlng, { radius: 5, color: '#5b8def', fillColor: '#fff', fillOpacity: 1, weight: 2, className: 'ruler-marker' }).addTo(map); S.ruler.markers.push(marker); updateRulerLine(); updateRulerLabels(); }
  function updateRulerLine() { if (S.ruler.polyline) { map.removeLayer(S.ruler.polyline); S.ruler.polyline = null; } if (S.ruler.points.length >= 2) { S.ruler.polyline = L.polyline(S.ruler.points, { color: '#5b8def', weight: 2, dashArray: '6 4', opacity: 0.8, className: 'ruler-line' }).addTo(map); } }
  function updateRulerLabels() { S.ruler.segmentLabels.forEach(function(l) { map.removeLayer(l); }); S.ruler.segmentLabels = []; if (S.ruler.label) { map.removeLayer(S.ruler.label); S.ruler.label = null; } if (S.ruler.points.length < 2) return; var totalDist = 0; for (var i = 1; i < S.ruler.points.length; i++) { totalDist += S.ruler.points[i - 1].distanceTo(S.ruler.points[i]); } var distKm = (totalDist / 1000).toFixed(1); var midIdx = Math.floor((S.ruler.points.length - 1) / 2); var midLatLng = S.ruler.points[midIdx]; var labelHtml = '<div class="ruler-label">📏 ' + distKm + ' км</div>'; S.ruler.label = L.marker(midLatLng, { icon: L.divIcon({ className: '', html: labelHtml, iconSize: [0, 0], iconAnchor: [0, 0] }) }).addTo(map); for (var j = 1; j < S.ruler.points.length; j++) { var p1 = S.ruler.points[j - 1], p2 = S.ruler.points[j]; var segDist = (p1.distanceTo(p2) / 1000).toFixed(1); var midSeg = L.latLng((p1.lat + p2.lat) / 2, (p1.lng + p2.lng) / 2); var segLabel = L.marker(midSeg, { icon: L.divIcon({ className: '', html: '<div class="ruler-segment-label">' + segDist + ' км</div>', iconSize: [0, 0], iconAnchor: [0, 0] }) }).addTo(map); S.ruler.segmentLabels.push(segLabel); } }
  function clearRuler() { S.ruler.points = []; if (S.ruler.polyline) { map.removeLayer(S.ruler.polyline); S.ruler.polyline = null; } if (S.ruler.label) { map.removeLayer(S.ruler.label); S.ruler.label = null; } S.ruler.segmentLabels.forEach(function(l) { map.removeLayer(l); }); S.ruler.segmentLabels = []; S.ruler.markers.forEach(function(m) { map.removeLayer(m); }); S.ruler.markers = []; }
  function rulerFinish(e) { if (!S.ruler.active) return; if (S.ruler.points.length < 2) { toast('Нужно минимум 2 точки'); } else { var total = 0; for (var i = 1; i < S.ruler.points.length; i++) { total += S.ruler.points[i - 1].distanceTo(S.ruler.points[i]); } toast('📏 Длина: ' + (total / 1000).toFixed(1) + ' км'); } toggleRuler(); }

  /* Строка легенды ДМРЛ-оверлея (📡 включён поверх текущего слоя) */
  /* Строки легенды грозопеленгатора (добавляются в конец при включённом ⚡) */
  function appendLtgLegend(el) {
    if (!ltg.on) return;
    var row = document.createElement('div'); row.className = 'li';
    var sq = document.createElement('div'); sq.className = 'lsq'; sq.style.background = '#ffd400';
    var t = document.createElement('span'); t.textContent = '⚡ Удар молнии (Blitzortung, real-time)';
    row.appendChild(sq); row.appendChild(t); el.appendChild(row);
    var n = document.createElement('div'); n.className = 'li legend-note'; n.textContent = 'Push по WebSocket · с момента включения · старше 10 мин скрываются';
    el.appendChild(n);
    var n2 = document.createElement('div'); n2.className = 'li legend-note'; n2.textContent = 'Клик по молнии — время/координаты удара';
    el.appendChild(n2);
  }
  function setLegendTitle(t) { var el = $('ltitle'); if (el.textContent !== t) { el.textContent = t; retrig(el, 'title-swap'); } }
  function buildLegend() { 
    var el = $('lbody'); el.innerHTML = ''; 
    /* ─── Легенды грозовых продуктов (раздел «Спутник») ─── */
    if (S.layer === 'sat' && satProduct) {
      var pdL = prodDef();
      var mkRow = function(color, text) {
        var row = document.createElement('div'); row.className = 'li';
        var sq = document.createElement('div'); sq.className = 'lsq'; sq.style.background = color;
        var tt = document.createElement('span'); tt.textContent = text;
        row.appendChild(sq); row.appendChild(tt); el.appendChild(row);
      };
      var mkNote = function(text) { var n = document.createElement('div'); n.className = 'li legend-note'; n.textContent = text; el.appendChild(n); };
      if (satProduct === 'height') {
        setLegendTitle('ВЫСОТА ВГО · BUFR (ДМРЛ)');
        /* Исправленная легенда: GetLegendGraphic источника отдаёт только цветные
           плашки без чисел. Используем те же RGB, но строим читаемую шкалу сами. */
        var hScale = document.createElement('div'); hScale.className = 'height-scale';
        HEIGHT_DISPLAY_PALETTE.forEach(function(p) {
          var rowH = document.createElement('div'); rowH.className = 'height-stop';
          var swH = document.createElement('i'); swH.style.background = 'rgb(' + p[1].join(',') + ')';
          var txH = document.createElement('span'); txH.textContent = p[0] + '–' + (p[0] + 1) + ' км';
          rowH.appendChild(swH); rowH.appendChild(txH); hScale.appendChild(rowH);
        });
        el.appendChild(hScale);
        mkNote('Высота верхней границы облаков · фактические цвета источника 4x4');
        mkNote('Станции: Москва · Новосибирск · Владивосток · шаг 10 мин');
        mkNote('Клик по карте — высота в точке');
        appendLtgLegend(el);
        return;
      }
      if (satProduct === 'composite') {
        setLegendTitle('COMPOSITE · ОТРАЖАЕМОСТЬ dBZ');
        /* шкала dBZ — стандартная палитра радара (цвета источника близки к ней) */
        BUILTIN_RADAR.forEach(function(e2, i2) {
          var rowC = document.createElement('div'); rowC.className = 'li'; rowC.style.setProperty('--i', Math.min(i2, 14));
          var sqC = document.createElement('div'); sqC.className = 'lsq'; sqC.style.background = 'rgb(' + e2.r.join(',') + ')';
          if (!e2.r[0] && !e2.r[1] && !e2.r[2]) sqC.style.border = '1px solid #555';
          var ttC = document.createElement('span'); ttC.textContent = e2.l;
          rowC.appendChild(sqC); rowC.appendChild(ttC); el.appendChild(rowC);
        });
        var regBtn = document.createElement('button');
        regBtn.className = 'btn mini-btn on';
        regBtn.textContent = 'Регион: ' + COMPOSITE_REGIONS[compositeRegionIdx].label;
        regBtn.addEventListener('click', function() { setCompositeRegion((compositeRegionIdx + 1) % COMPOSITE_REGIONS.length); });
        el.appendChild(regBtn);
        mkNote('Композит отражаемости · 4x4 · шаг 10 мин');
        mkNote('FMI — Европа/СЗ РФ; ДМРЛ РФ — Москва/Новосибирск/Владивосток');
      } else if (satProduct === 'cape') {
        setLegendTitle('CAPE · Дж/кг');
        var gC = document.createElement('div'); gC.className = 'lgrad li';
        gC.style.background = 'linear-gradient(to right, #4ade80, #fde047, #f97316, #dc2626, #a21caf)';
        el.appendChild(gC);
        var capC = document.createElement('div'); capC.className = 'li lgrad-cap';
        capC.innerHTML = '<span>100</span><span>1000</span><span>3000+</span>'; el.appendChild(capC);
        mkRow('#4ade80', '100–500 — слабая неустойчивость');
        mkRow('#fde047', '500–1000 — умеренная');
        mkRow('#f97316', '1000–2000 — сильная');
        mkRow('#dc2626', '2000–3000 — очень сильная');
        mkRow('#a21caf', '>3000 — экстремальная');
        mkNote('CAPE — конвективная доступная потенциальная энергия');
        mkNote('Модель Open-Meteo · сетка по видимой области · час, ближайший к текущему');
      } else if (satProduct === 'cin') {
        setLegendTitle('CIN · Дж/кг');
        var gI = document.createElement('div'); gI.className = 'lgrad li';
        gI.style.background = 'linear-gradient(to right, #93c5fd, #3b82f6, #1d4ed8, #6b21a8)';
        el.appendChild(gI);
        var capI = document.createElement('div'); capI.className = 'li lgrad-cap';
        capI.innerHTML = '<span>15</span><span>100</span><span>200+</span>'; el.appendChild(capI);
        mkRow('#93c5fd', '15–50 — слабое подавление');
        mkRow('#3b82f6', '50–100 — умеренное');
        mkRow('#1d4ed8', '100–200 — сильное');
        mkRow('#6b21a8', '>200 — конвекция маловероятна');
        mkNote('CIN — энергия задерживающего слоя (подавляет развитие конвекции)');
        mkNote('Модель Open-Meteo · сетка по видимой области');
      } else if (satProduct === 'scp') {
        setLegendTitle('SUPERCELL · ОЦЕНКА');
        mkRow('#fde047', '1 — слабые условия (CAPE≥800, сдвиг≥12 м/с)');
        mkRow('#f97316', '2 — умеренные (CAPE≥1500, сдвиг≥15 м/с)');
        mkRow('#dc2626', '3 — сильные (CAPE≥2500, сдвиг≥20 м/с)');
        mkNote('Совместно: CAPE и сдвиг ветра 10→180 м (proxy сдвига 0–6 км)');
        mkNote('⚠️ Приближённая оценка по модели Open-Meteo, НЕ SCP NOAA');
      }
      appendLtgLegend(el);
      return;
    }
    if (S.layer === 'sat') {
      var ch = SAT_CHANNELS[satChIdx];
      setLegendTitle('СПУТНИК · ' + ch.label.toUpperCase());
      var idx = 0;
      var pal = satActivePalette();
      if (pal && pal.items && pal.items.length && !pal.legendOnly) {
        /* Легенда из активной палитры канала: градиент по стопам (v по возрастанию) + строки */
        var asc = pal.items.slice().sort(function(a, b) { return a.v - b.v; });
        var g = document.createElement('div'); g.className = 'lgrad li';
        g.style.background = 'linear-gradient(to right, ' + asc.map(function(it) { return 'rgb(' + it.r.join(',') + ')'; }).join(', ') + ')';
        g.style.setProperty('--i', idx++);
        el.appendChild(g);
        var cap = document.createElement('div'); cap.className = 'li lgrad-cap'; cap.style.setProperty('--i', idx++);
        cap.innerHTML = '<span>тепло</span><span>холодно</span>';
        el.appendChild(cap);
        pal.items.forEach(function(it) {
          var row = document.createElement('div'); row.className = 'li'; row.style.setProperty('--i', Math.min(idx++, 14));
          var sq = document.createElement('div'); sq.className = 'lsq'; sq.style.background = 'rgb(' + it.r.join(',') + ')';
          var t = document.createElement('span'); t.textContent = it.l;
          row.appendChild(sq); row.appendChild(t); el.appendChild(row);
        });
        if (pal.noRecolor) { var nr = document.createElement('div'); nr.className = 'li legend-note'; nr.style.setProperty('--i', Math.min(idx++, 14)); nr.textContent = 'Оригинальные тона канала'; el.appendChild(nr); }
      } else {
        /* Fallback: стандартная легенда канала (RGB-каналы и т.п.) */
        var lg = ch.legend || {};
        if (lg.grad) {
          var g2 = document.createElement('div'); g2.className = 'lgrad li';
          g2.style.background = 'linear-gradient(to right, ' + lg.grad.join(', ') + ')';
          g2.style.setProperty('--i', idx++);
          el.appendChild(g2);
          var cap2 = document.createElement('div'); cap2.className = 'li lgrad-cap'; cap2.style.setProperty('--i', idx++);
          cap2.innerHTML = '<span>холодно</span><span>тепло</span>';
          el.appendChild(cap2);
        }
        (lg.rows || []).forEach(function(r) {
          var row = document.createElement('div'); row.className = 'li'; row.style.setProperty('--i', Math.min(idx++, 14));
          var sq = document.createElement('div'); sq.className = 'lsq'; sq.style.background = r[0];
          var t = document.createElement('span'); t.textContent = r[1];
          row.appendChild(sq); row.appendChild(t); el.appendChild(row);
        });
      }
      if (ch.day) { var d = document.createElement('div'); d.className = 'li legend-note'; d.style.setProperty('--i', Math.min(idx++, 14)); d.textContent = '☀️ Канал информативен только днём'; el.appendChild(d); }
      var opn = document.createElement('div'); opn.className = 'li legend-note'; opn.style.setProperty('--i', Math.min(idx++, 14)); opn.textContent = 'Прозрачность слоя: 50%'; el.appendChild(opn);
      /* Обязательная атрибуция по лицензии EUMETSAT */
      var attr = document.createElement('div'); attr.className = 'li legend-note'; attr.style.setProperty('--i', Math.min(idx++, 14)); attr.textContent = '© EUMETSAT'; el.appendChild(attr);
      /* Тумблер тёмной подложки: пользователь сам решает — «спутник на белой карте»
         или «на тёмной подложке». Живёт в легенде: это настройка отображения слоя,
         и результат виден сразу рядом. Состояние — в localStorage (satBackdrop). */
      if (currentTheme !== 'dark') {
        var bdBtn = document.createElement('button');
        bdBtn.className = 'btn mini-btn' + (satBackdropOn ? ' on' : '');
        bdBtn.textContent = satBackdropOn ? 'Тёмная подложка: вкл' : 'Тёмная подложка: выкл';
        bdBtn.addEventListener('click', function() {
          satBackdropOn = !satBackdropOn;
          try { localStorage.setItem('satBackdrop', satBackdropOn ? '1' : '0'); } catch (e) {}
          /* Без подложки 50% на белой карте выцветает — поднимаем непрозрачность
             (обводка данных исказила бы снимок, поэтому именно прозрачность) */
          if (!satBackdropOn && satOpacityMem <= 55) {
            satOpacityMem = 75;
            $('opacity-slider').value = 75; $('opacity-val').textContent = '75%';
            if (eumetsatLayer) eumetsatLayer.setOpacity(0.75);
            toast('Подложка выключена — непрозрачность поднята до 75%');
          }
          updateSatBackdrop(true); buildLegend(); satUpdateChip();
        });
        el.appendChild(bdBtn);
      }
      appendLtgLegend(el);
      return;
    }
    if (S.layer === 'dop') {
      setLegendTitle('ДОПЛЕР · РАДИАЛЬНАЯ СКОРОСТЬ');
      /* Дискретная шкала с точной подписью каждого класса: −50, −45 … +50 м/с. */
      var dopScale = document.createElement('div'); dopScale.className = 'doppler-scale';
      DOP_DISPLAY_PALETTE.forEach(function(p) {
        var cell = document.createElement('div'); cell.className = 'doppler-stop';
        cell.style.background = 'rgb(' + p[1].join(',') + ')';
        cell.title = (p[0] > 0 ? '+' : '') + p[0] + ' м/с';
        var label = document.createElement('span'); label.textContent = (p[0] > 0 ? '+' : '') + p[0];
        cell.appendChild(label); dopScale.appendChild(cell);
      });
      el.appendChild(dopScale);
      var cap = document.createElement('div'); cap.className = 'li lgrad-cap';
      cap.innerHTML = '<span>к радару</span><span>0 м/с</span><span>от радара</span>'; el.appendChild(cap);
      var n1 = document.createElement('div'); n1.className = 'li legend-note'; n1.textContent = 'Высота: ' + DOP_HEIGHTS[dopHeightIdx].label + ' · шаг 10 мин'; el.appendChild(n1);
      var n2 = document.createElement('div'); n2.className = 'li legend-note'; n2.textContent = 'Радиальная скорость ДМРЛ · 4x4 (Росгидромет/BUFR)'; el.appendChild(n2);
      var n3 = document.createElement('div'); n3.className = 'li legend-note'; n3.textContent = 'Покрытие: Москва/Новосибирск/Владивосток + FMI (не вся РФ)'; el.appendChild(n3);
      var n4 = document.createElement('div'); n4.className = 'li legend-note'; n4.textContent = 'Клик по карте — скорость (м/с) в точке'; el.appendChild(n4);
      appendLtgLegend(el);
      return;
    }
    /* ─── БЛОК A: легенда ОЯ-BUFR (wx + nowcast) — ФАКТИЧЕСКАЯ палитра источника.
       Цвета сняты с GetLegendGraphic bufr_phenomena и сверены по пикселям через
       GetFeatureInfo → легенда всегда совпадает с картинкой. Реколоризация явлений
       (как у dBZ) сознательно НЕ делается: цвет здесь кодирует ТИП явления,
       перекраска под пороговую палитру сайта потеряла бы смысл. ─── */
    if (S.layer === 'wx' && radarSource === 'nowcast') {
      setLegendTitle('ПОГОДНЫЕ ЯВЛЕНИЯ · BUFR');
      WX_NC_PALETTE.forEach(function(p, i) {
        var row = document.createElement('div'); row.className = 'li'; row.style.setProperty('--i', Math.min(i, 14));
        var sq = document.createElement('div'); sq.className = 'lsq'; sq.style.background = p[1];
        var tt = document.createElement('span'); tt.textContent = p[2];
        row.appendChild(sq); row.appendChild(tt); el.appendChild(row);
      });
      var wxSrcBtn = document.createElement('button');
      wxSrcBtn.className = 'btn mini-btn on';
      wxSrcBtn.textContent = 'Источник: 4x4 (ДМРЛ)';
      wxSrcBtn.addEventListener('click', function() { setRadarSource('rainradar', false); });
      el.appendChild(wxSrcBtn);
      var wn1 = document.createElement('div'); wn1.className = 'li legend-note';
      wn1.textContent = 'ОЯ BUFR — опасные явления ДМРЛ (4x4), палитра источника';
      el.appendChild(wn1);
      var wn2 = document.createElement('div'); wn2.className = 'li legend-note';
      wn2.textContent = 'Станции: Москва · Новосибирск · Владивосток';
      el.appendChild(wn2);
      var wn3 = document.createElement('div'); wn3.className = 'li legend-note';
      wn3.textContent = 'Наведение и клик — тип явления в точке';
      el.appendChild(wn3);
      appendLtgLegend(el);
      return;
    }
    var items = getCurrentPaletteItems(); var title = S.layer === 'radar' ? 'ОТРАЖАЕМОСТЬ dBZ' : 'ПОГОДНЫЕ ЯВЛЕНИЯ'; setLegendTitle(title); 
    var isRadarLegend = S.layer === 'radar' || S.layer === 'wx'; /* переключатель источника у обоих */
    items.forEach(function(p, i) { var row = document.createElement('div'); row.className = 'li'; row.style.setProperty('--i', Math.min(i, 14)); var sq = document.createElement('div'); sq.className = 'lsq'; sq.style.background = 'rgb(' + p.r + ')'; if (!p.r[0] && !p.r[1] && !p.r[2]) sq.style.border = '1px solid #555'; var t = document.createElement('span'); t.textContent = p.l; row.appendChild(sq); row.appendChild(t); el.appendChild(row); }); 
    if (isRadarLegend) {
      /* Переключатель источника радара: nowcast (ДМРЛ, основной) ↔ rainradar (запасной) */
      var srcBtn = document.createElement('button');
      srcBtn.className = 'btn mini-btn' + (radarSource === 'nowcast' ? ' on' : '');
      srcBtn.textContent = 'Источник: ' + (radarSource === 'nowcast' ? '4x4 (ДМРЛ)' : 'rainradar');
      srcBtn.addEventListener('click', function() { setRadarSource(radarSource === 'nowcast' ? 'rainradar' : 'nowcast', false); });
      el.appendChild(srcBtn);
      if (radarSource === 'nowcast' && S.layer === 'radar') {
        /* Выбор данных nowcast: станции ДМРЛ РФ или композит FMI (Европа) */
        var dataBtn = document.createElement('button');
        dataBtn.className = 'btn mini-btn';
        dataBtn.textContent = 'Данные: ' + RADAR_NC_LAYERS[radarNcIdx].label;
        dataBtn.addEventListener('click', function() { setRadarNcData((radarNcIdx + 1) % RADAR_NC_LAYERS.length); });
        el.appendChild(dataBtn);
        var ncNote = document.createElement('div'); ncNote.className = 'li legend-note';
        ncNote.textContent = 'ДМРЛ-покрытие: Москва/Новосибирск/Владивосток; указатель и попап работают; CSV — в режиме rainradar';
        el.appendChild(ncNote);
        if (radarSourceAuto) { var an = document.createElement('div'); an.className = 'li legend-note'; an.textContent = 'Был авто-переход на rainradar — вернитесь кнопкой выше'; el.appendChild(an); }
      }
    }
    appendLtgLegend(el);
  }

  function toggleLegend() { var lg = $('legend'), btn = $('toggle-legend-btn'); if (S.legendVis) { lg.classList.add('collapsed'); btn.innerHTML = '+'; } else { lg.classList.remove('collapsed'); btn.innerHTML = '−'; } S.legendVis = !S.legendVis; saveViewDebounced(); }
  /* ─── Toast: отдельный элемент снизу по центру, fade+slide, очередь сообщений.
     Сигнатура toast(m) сохранена — все существующие вызовы работают ─── */
  var toastEl = document.createElement('div');
  toastEl.id = 'toast'; toastEl.setAttribute('role', 'status');
  document.body.appendChild(toastEl);
  var toastQueue = [], toastActive = false;
  function toast(m) {
    toastQueue.push(m);
    if (toastQueue.length > 3) toastQueue = toastQueue.slice(-3); /* не копим лавину */
    if (!toastActive) nextToast();
  }
  function nextToast() {
    if (!toastQueue.length) { toastActive = false; return; }
    toastActive = true;
    toastEl.textContent = toastQueue.shift();
    toastEl.classList.add('show');
    setTimeout(function() {
      toastEl.classList.remove('show');
      setTimeout(nextToast, REDUCE_MOTION ? 30 : 220); /* дождаться fade-out */
    }, 2500);
  }

  /* Авто-подтяжка данных: радар — каждую минуту; спутник — при появлении нового 15-мин кадра */
  setInterval(function() {
    if (S.layer === 'dop') return; /* кадр подтягивает свой интервал доплера */
    if (S.playing || S.manualTime) { if (S.layer !== 'sat') buildFrames(); return; }
    var n = nowTs();
    if (n !== S.ts) {
      S.ts = n; updHUD();
      if (S.layer === 'sat') { satApplyTime(true); buildFrames(); if (!satProduct) toast('Новый снимок спутника'); }
      else if (radarNcActive()) {
        /* БЛОК C: постоянная передача nowcast — новый кадр раз в ~10 мин, без тоста
           (чип покажет время сам); при скрытой вкладке не дёргаем сеть */
        if (document.visibilityState !== 'hidden') { radarNcApply(true); buildFrames(); }
      }
      else { forceRefresh(); toast('Новые данные'); }
    }
    buildFrames();
  }, 60000);

  var hoverEl = $('hover-indicator'), popupEl = $('pixel-popup'), crosshairEl = $('crosshair'), crosshairLbl = $('crosshair-label');
  var popupVisible = false, crosshairMode = false;
  function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function findPalEntry(r, g, b) { var items = getCurrentPaletteItems(), best = null, bd = 1e9; for (var i = 0; i < items.length; i++) { var p = items[i], dr = r - p.r[0], dg = g - p.r[1], db = b - p.r[2], d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; best = p; } } return bd < 3000 ? { label: best.l, v: best.v } : null; }

  /* ─── Указатель/прицел на nowcast-слоях: цвет пикселя читаем ПРЯМО из WMS-тайла.
     Тайлы идут через свой прокси /api/nowcastProxy (или dataURL после реколоризации)
     → canvas не tainted, сети не нужно: работает так же мгновенно, как канвасный
     режим rainradar. Тайл рисуется в кэш-канвас один раз, дальше — getImageData 1px. */
  var ncPixCache = new Map(), NC_PIX_MAX = 32; /* src тайла → canvas */
  function ncTileCanvas(img) {
    var key = img.src;
    var c = ncPixCache.get(key);
    if (c) return c;
    try {
      c = document.createElement('canvas');
      c.width = img.naturalWidth || 256; c.height = img.naturalHeight || 256;
      c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    } catch (e) { return null; }
    if (ncPixCache.size >= NC_PIX_MAX) ncPixCache.delete(ncPixCache.keys().next().value);
    ncPixCache.set(key, c);
    return c;
  }
  /* ОЯ: цвет → явление по фактической палитре BUFR (nearest, порог как у радара) */
  function wxNcFindInfo(r, g, b) {
    var best = -1, bd = 1e9;
    for (var i = 0; i < WX_NC_RGB.length; i++) {
      var e = WX_NC_RGB[i], dr = r - e[0], dg = g - e[1], db = b - e[2];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return (best >= 0 && bd <= 4000) ? { label: WX_NC_PALETTE[best][2], v: WX_NC_PALETTE[best][0] } : null;
  }
  /* Доплер: цвет → скорость по калиброванной таблице DOP_NC_RGB (nearest) */
  function dopNcFindInfo(r, g, b) {
    var best = -1, bd = 1e9;
    /* Сначала новая экранная палитра (точные классы по 5 м/с). */
    for (var i = 0; i < DOP_DISPLAY_PALETTE.length; i++) {
      var p = DOP_DISPLAY_PALETTE[i], dr = r - p[1][0], dg = g - p[1][1], db = b - p[1][2];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd <= 1800) {
      var v = DOP_DISPLAY_PALETTE[best][0];
      return { label: (v > 0 ? '+' : '') + v + ' м/с' + (v < 0 ? ' · к радару' : (v > 0 ? ' · от радара' : ' · нулевая изодопа')), v: v };
    }
    /* Fallback для исходного тайла до завершения реколоризации. */
    best = -1; bd = 1e9;
    for (var j = 0; j < DOP_NC_RGB.length; j++) {
      var e = DOP_NC_RGB[j], dr2 = r - e[0], dg2 = g - e[1], db2 = b - e[2];
      var d2 = dr2 * dr2 + dg2 * dg2 + db2 * db2;
      if (d2 < bd) { bd = d2; best = j; }
    }
    return (best >= 0 && bd <= 6000) ? { label: DOP_NC_RGB[best][4], v: DOP_NC_RGB[best][3] } : null;
  }
  function getNcBlockAt(mx, my) {
    /* радар/ОЯ: главный слой + доп. станции; доплер: WMS-слой скорости */
    var lyrs = (S.layer === 'dop') ? [nowcastLayer] : [radarNcLayer].concat(wxNcExtras);
    var latlng = map.containerPointToLatLng(L.point(mx, my));
    for (var li = 0; li < lyrs.length; li++) {
      var lyr = lyrs[li];
      if (!lyr || !lyr._tiles) continue;
      var z = (lyr._tileZoom != null) ? lyr._tileZoom : map.getZoom();
      var ts = 256;
      var pp = map.project(latlng, z);
      var tx = Math.floor(pp.x / ts), ty = Math.floor(pp.y / ts);
      var t = lyr._tiles[tx + ':' + ty + ':' + z];
      if (!t || !t.el || !t.el.complete || !t.el.naturalWidth) continue;
      var cnv = ncTileCanvas(t.el);
      if (!cnv) continue;
      var ix = Math.max(0, Math.min(cnv.width - 1, Math.floor((pp.x - tx * ts) * cnv.width / ts)));
      var iy = Math.max(0, Math.min(cnv.height - 1, Math.floor((pp.y - ty * ts) * cnv.height / ts)));
      var pd;
      try { pd = cnv.getContext('2d').getImageData(ix, iy, 1, 1).data; } catch (e) { continue; }
      if (pd[3] < 40) continue; /* прозрачно у этой станции — пробуем следующую */
      /* рамка указателя: границы пикселя изображения → экранные координаты */
      var fx = ts / cnv.width, fy = ts / cnv.height;
      var c1 = map.latLngToContainerPoint(map.unproject(L.point(tx * ts + ix * fx, ty * ts + iy * fy), z));
      var c2 = map.latLngToContainerPoint(map.unproject(L.point(tx * ts + (ix + 1) * fx, ty * ts + (iy + 1) * fy), z));
      var info = (S.layer === 'dop') ? dopNcFindInfo(pd[0], pd[1], pd[2]) : ((S.layer === 'wx') ? wxNcFindInfo(pd[0], pd[1], pd[2]) : findPalEntry(pd[0], pd[1], pd[2]));
      return {
        sx: Math.round(Math.min(c1.x, c2.x)), sy: Math.round(Math.min(c1.y, c2.y)),
        sw: Math.max(4, Math.round(Math.abs(c2.x - c1.x))), sh: Math.max(4, Math.round(Math.abs(c2.y - c1.y))),
        color: 'rgb(' + pd[0] + ',' + pd[1] + ',' + pd[2] + ')', r: pd[0], g: pd[1], b: pd[2],
        info: info, dbz: -1 /* у WMS-пикселя точного dBZ нет — прицел покажет порог «≥v» */
      };
    }
    return null;
  }
  
  function getBlockAt(mx, my) { 
    if (S.layer === 'dop') return getNcBlockAt(mx, my); /* доплер: скорость из пикселя WMS-тайла */
    if ((S.layer !== 'radar' && S.layer !== 'wx') || !S.dbzVisible) return null;
    if (radarNcActive()) return getNcBlockAt(mx, my); /* nowcast: пиксель читается из WMS-тайла */
    var tiles = visTiles(); 
    for (var i = 0; i < tiles.length; i++) { 
      var t = tiles[i], r = tileRect(t.x, t.y); 
      if (r.sw <= 0 || r.sh <= 0 || mx < r.sx || mx >= r.sx + r.sw || my < r.sy || my >= r.sy + r.sh) continue; 
      var ck = CK(t.x, t.y), entry = S.cache.get(ck); 
      if (!entry || !entry.canvas) return null; 
      var targetSize = entry.canvas.width; var effectivePx = (S.px < 1) ? 1 : S.px; 
      var oxF = Math.max(0, Math.min(targetSize - 0.1, (mx - r.sx) / r.sw * targetSize)); 
      var oyF = Math.max(0, Math.min(targetSize - 0.1, (my - r.sy) / r.sh * targetSize)); 
      var bx = Math.floor(oxF / effectivePx) * effectivePx; var by = Math.floor(oyF / effectivePx) * effectivePx; 
      var bx2 = Math.min(bx + effectivePx, targetSize); var by2 = Math.min(by + effectivePx, targetSize); 
      var cx2 = (bx + bx2) / 2 | 0; var cy2 = (by + by2) / 2 | 0; 
      try { 
        var pd = entry.canvas.getContext('2d').getImageData(cx2, cy2, 1, 1).data; 
        if (!pd[3]) return null; 
        var scX = r.sw / targetSize; var scY = r.sh / targetSize; var dbz = -1; 
        if (entry.raw && entry.raw.length > 0) { var ix = Math.round(cx2); var iy = Math.round(cy2); if (ix >= 0 && ix < targetSize && iy >= 0 && iy < targetSize) { var rawIdx = iy * targetSize + ix; if (rawIdx < entry.raw.length) { dbz = entry.raw[rawIdx]; } } } 
        return { sx: r.sx + Math.round(bx * scX), sy: r.sy + Math.round(by * scY), sw: Math.max(4, Math.round(effectivePx * scX)), sh: Math.max(4, Math.round(effectivePx * scY)), color: 'rgb(' + pd[0] + ',' + pd[1] + ',' + pd[2] + ')', r: pd[0], g: pd[1], b: pd[2], info: findPalEntry(pd[0], pd[1], pd[2]), dbz: dbz }; 
      } catch (e) { return null; } 
    } 
    return null; 
  }
  
  function updateCrosshair() { if (!crosshairMode || S.layer === 'sat') return; var cx = innerWidth / 2, cy = innerHeight / 2, block = getBlockAt(cx, cy); if (block) { hoverEl.style.display = 'block'; hoverEl.style.left = block.sx + 'px'; hoverEl.style.top = block.sy + 'px'; hoverEl.style.width = block.sw + 'px'; hoverEl.style.height = block.sh + 'px'; hoverEl.style.background = 'transparent'; var info = block.info; var txt = '—'; if (info) { if (S.layer === 'radar') { if (block.dbz >= 0) { txt = Math.round(block.dbz) + ' dBZ | ' + info.label; } else { txt = '≥' + info.v + ' dBZ | ' + info.label; } } else { txt = info.label; } } crosshairLbl.innerHTML = '<span class="ch-swatch" style="background:' + block.color + '"></span>' + txt; /* цвет данных — inline, рамка — токен темы */ crosshairLbl.style.display = 'block'; var lw = crosshairLbl.offsetWidth || 200, lh = crosshairLbl.offsetHeight || 36, lx = cx - lw / 2, ly = cy - 50 - lh; if (ly < 8) ly = cy + 50; crosshairLbl.style.left = lx + 'px'; crosshairLbl.style.top = ly + 'px'; } else { hoverEl.style.display = 'none'; /* тайлы ещё в пути → честная «загрузка», а не «нет данных» */ var waiting = (S.layer === 'dop' && nowcastLoading) || (radarNcActive() && radarNcLoading); crosshairLbl.innerHTML = '<span class="ch-nodata">' + (waiting ? '⏳ загрузка…' : 'нет данных') + '</span>'; crosshairLbl.style.display = 'block'; crosshairLbl.style.left = (innerWidth / 2 - (crosshairLbl.offsetWidth || 120) / 2) + 'px'; crosshairLbl.style.top = (innerHeight / 2 - 60) + 'px'; } }
  function toggleCrosshair() { crosshairMode = !crosshairMode; var btn = $('btn-crosshair'); if (crosshairMode) { btn.classList.add('on'); crosshairEl.style.display = 'block'; updateCrosshair(); } else { btn.classList.remove('on'); crosshairEl.style.display = 'none'; crosshairLbl.style.display = 'none'; hoverEl.style.display = 'none'; } if (S.ruler.active) toggleRuler(); }
  function showPopup(block, mx, my) { var info = block.info; var lbl = info ? escHtml(info.label) : '—'; var meta = ''; if (info) { if (S.layer === 'radar') { if (block.dbz >= 0) { meta = 'Слой: <b>Отражаемость</b><br>Значение: <b>' + Math.round(block.dbz) + '</b> dBZ<br>Категория: ' + info.label; } else { meta = 'Слой: <b>Отражаемость</b><br>Порог: ≥' + info.v + ' dBZ<br>Категория: ' + info.label; } } else { meta = 'Слой: <b>Явления</b><br>' + info.label; } } else { meta = 'Нет данных'; } popupEl.innerHTML = '<div class="popup-header"><div class="popup-swatch" style="background:' + block.color + '"></div><div class="popup-label">' + lbl + '</div></div><div class="popup-meta">' + meta + '</div><span class="popup-close" onclick="document.getElementById(\'pixel-popup\').style.display=\'none\'">✕</span>'; popupEl.style.display = 'block'; popupEl.classList.remove('popup-in'); void popupEl.offsetWidth; popupEl.classList.add('popup-in'); var px2 = mx + 16, py2 = my - 55; if (px2 + 230 > innerWidth - 8) px2 = mx - 246; if (py2 < 8) py2 = 8; if (py2 + 110 > innerHeight - 8) py2 = innerHeight - 118; popupEl.style.left = px2 + 'px'; popupEl.style.top = py2 + 'px'; popupVisible = true; }
  function hidePopup() { popupEl.style.display = 'none'; popupVisible = false; }

  /* ─── БЛОК A: попап ОЯ-BUFR через WMS GetFeatureInfo (nowcast) ───
     Ответ nowcast — HTML со строкой «var value=N», N — код явления BUFR
     (расшифровка в WX_NC_CODES, таблица снята с живого ответа сервера).
     Запрашиваем крошечный bbox 11×11 px вокруг точки клика в EPSG:4326 —
     точное попадание без искажений меркатора. Прокси пробрасывает query 1:1. */
  var wxNcGfiSeq = 0; /* защита от гонки: показываем только последний ответ */
  function wxNcQueryStation(st, latlng, time) {
    var d = 0.03;
    var url = '/api/nowcastProxy?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo' +
      '&LAYERS=' + st.id + '&QUERY_LAYERS=' + st.id +
      '&SRS=EPSG:4326&BBOX=' + (latlng.lng - d) + ',' + (latlng.lat - d) + ',' + (latlng.lng + d) + ',' + (latlng.lat + d) +
      '&WIDTH=11&HEIGHT=11&X=5&Y=5&FORMAT=image%2Fpng&INFO_FORMAT=text%2Fhtml' +
      (time ? '&TIME=' + encodeURIComponent(time) : '');
    return fetch(url)
      .then(function(r) { return r.ok ? r.text() : ''; })
      .then(function(txt) { var m = /var value=(\d+)/.exec(txt); return { st: st, code: m ? parseInt(m[1], 10) : null }; })
      .catch(function() { return { st: st, code: null }; });
  }
  function wxNcColorFor(code) {
    for (var i = 0; i < WX_NC_PALETTE.length; i++) if (WX_NC_PALETTE[i][0] === code) return WX_NC_PALETTE[i][1];
    return 'rgba(128,128,128,0.35)';
  }
  /* Позиционирование попапа — тот же расчёт, что в showPopup */
  function placePopup(mx, my) {
    popupEl.style.display = 'block'; popupEl.classList.remove('popup-in'); void popupEl.offsetWidth; popupEl.classList.add('popup-in');
    var px2 = mx + 16, py2 = my - 55;
    if (px2 + 230 > innerWidth - 8) px2 = mx - 246;
    if (py2 < 8) py2 = 8;
    if (py2 + 110 > innerHeight - 8) py2 = innerHeight - 118;
    popupEl.style.left = px2 + 'px'; popupEl.style.top = py2 + 'px'; popupVisible = true;
  }
  function wxNcShowPopup(latlng, mx, my) {
    var seq = ++wxNcGfiSeq;
    var t = new Date(S.ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    var closeBtn = '<span class="popup-close" onclick="document.getElementById(\'pixel-popup\').style.display=\'none\'">✕</span>';
    /* мгновенный отклик: попап со статусом, ответ подставим по готовности */
    popupEl.innerHTML = '<div class="popup-header"><div class="popup-label">⏳ Запрос явления…</div></div>' +
      '<div class="popup-meta">ОЯ BUFR · 4x4 · кадр ' + t + ' МСК</div>' + closeBtn;
    placePopup(mx, my);
    var live = S.ts >= nowTs();
    var time = live ? null : satIso(S.ts); /* исторический кадр — тот же TIME, что у слоя */
    Promise.all(WX_NC_LAYERS.map(function(st) { return wxNcQueryStation(st, latlng, time); })).then(function(res) {
      if (seq !== wxNcGfiSeq || !popupVisible) return; /* пришёл более новый клик / попап закрыт */
      /* станции не пересекаются: значимый ответ максимум у одной — берём максимальный код */
      var best = null;
      res.forEach(function(r) { if (r.code !== null && r.code !== 255 && (best === null || r.code > best.code)) best = r; });
      var lbl, meta, color;
      if (!best) {
        lbl = 'Вне зоны покрытия BUFR'; color = 'rgba(128,128,128,0.35)';
        meta = 'Станции: Москва · Новосибирск · Владивосток<br>Кадр: ' + t + ' МСК';
      } else {
        lbl = WX_NC_CODES[best.code] || ('код ' + best.code);
        color = wxNcColorFor(best.code);
        meta = 'Слой: <b>ОЯ BUFR</b> (4x4)<br>Станция: ' + escHtml(best.st.label) + '<br>Код явления: ' + best.code + '<br>Кадр: ' + t + ' МСК';
      }
      popupEl.innerHTML = '<div class="popup-header"><div class="popup-swatch" style="background:' + color + '"></div><div class="popup-label">' + escHtml(lbl) + '</div></div>' +
        '<div class="popup-meta">' + meta + '</div>' + closeBtn;
    });
  }

  /* ─── Указатель на доплере: радиальная скорость в точке через GetFeatureInfo.
     Формула конвертации — из собственного скрипта nowcast (виден в ответе
     GetFeatureInfo): value=1 → нет эха; иначе v = 63.5·(−1 + (value−1)·2/254) м/с.
     Отрицательные — К радару, положительные — ОТ радара. ─── */
  function dopShowPopup(latlng, mx, my) {
    var seq = ++wxNcGfiSeq; /* общий guard от гонки с попапом ОЯ */
    var t = new Date(S.ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    var closeBtn = '<span class="popup-close" onclick="document.getElementById(\'pixel-popup\').style.display=\'none\'">✕</span>';
    popupEl.innerHTML = '<div class="popup-header"><div class="popup-label">⏳ Запрос скорости…</div></div>' +
      '<div class="popup-meta">Доплер ДМРЛ · 4x4 · ' + DOP_HEIGHTS[dopHeightIdx].label + '</div>' + closeBtn;
    placePopup(mx, my);
    var live = S.ts >= nowTs();
    var time = live ? null : satIso(S.ts);
    wxNcQueryStation({ id: DOP_HEIGHTS[dopHeightIdx].id, label: DOP_HEIGHTS[dopHeightIdx].label }, latlng, time).then(function(r) {
      if (seq !== wxNcGfiSeq || !popupVisible) return;
      var lbl, meta, color;
      if (r.code === null) {
        lbl = 'Вне зоны покрытия'; color = 'rgba(128,128,128,0.35)';
        meta = 'Покрытие ДМРЛ: Москва/Новосибирск/Владивосток<br>Кадр: ' + t + ' МСК';
      } else if (r.code <= 1) {
        lbl = 'Нет эха'; color = 'rgba(128,128,128,0.35)';
        meta = 'Слой: <b>Радиальная скорость</b><br>Высота: ' + DOP_HEIGHTS[dopHeightIdx].label + '<br>Кадр: ' + t + ' МСК';
      } else {
        var v = 63.5 * (-1 + (r.code - 1) * 2 / 254);
        var dir = v < -1 ? 'к радару' : (v > 1 ? 'от радара' : 'поперёк луча');
        lbl = (v > 0 ? '+' : '') + v.toFixed(1) + ' м/с (' + dir + ')';
        var dc = dopDisplayColor(v);
        color = 'rgb(' + dc.join(',') + ')'; /* тот же класс −50…+50, что на карте и в легенде */
        meta = 'Слой: <b>Радиальная скорость</b> (4x4)<br>Высота: ' + DOP_HEIGHTS[dopHeightIdx].label + '<br>Код пикселя: ' + r.code + '<br>Кадр: ' + t + ' МСК';
      }
      popupEl.innerHTML = '<div class="popup-header"><div class="popup-swatch" style="background:' + color + '"></div><div class="popup-label">' + escHtml(lbl) + '</div></div>' +
        '<div class="popup-meta">' + meta + '</div>' + closeBtn;
    });
  }

  map.on('mousemove', function(e) { if (crosshairMode) { requestAnimationFrame(updateCrosshair); return; } if (S.layer === 'sat') return; var p = e.containerPoint, block = getBlockAt(p.x, p.y); if (block) { hoverEl.style.display = 'block'; hoverEl.style.left = block.sx + 'px'; hoverEl.style.top = block.sy + 'px'; hoverEl.style.width = block.sw + 'px'; hoverEl.style.height = block.sh + 'px'; hoverEl.style.background = block.color; } else hoverEl.style.display = 'none'; });
  /* ─── Попап молнии: ближайший удар в радиусе ~10px от клика ─── */
  function ltgFindNear(px, py) {
    if (!ltg.on || !ltg.strikes.length) return null;
    var best = null, bd = 100, now = Date.now() / 1000; /* 10px² */
    for (var i = ltg.strikes.length - 1; i >= 0; i--) {
      var st = ltg.strikes[i];
      if (now - st[2] > 600) break; /* дальше только старше (массив упорядочен по времени) */
      var pt = map.latLngToContainerPoint([st[0], st[1]]);
      var dx = pt.x - px, dy = pt.y - py, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }
  function ltgShowPopup(st, mx, my) {
    var now = Date.now() / 1000, age = Math.max(0, Math.round(now - st[2]));
    var ageTxt = age < 60 ? age + ' с назад' : Math.round(age / 60) + ' мин назад';
    var t = new Date(st[2] * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Moscow' });
    var closeBtn = '<span class="popup-close" onclick="document.getElementById(\'pixel-popup\').style.display=\'none\'">✕</span>';
    popupEl.innerHTML = '<div class="popup-header"><div class="popup-swatch" style="background:#ffd400"></div><div class="popup-label">⚡ Удар молнии</div></div>' +
      '<div class="popup-meta">Время: <b>' + t + '</b> МСК (' + ageTxt + ')<br>Координаты: ' + st[0].toFixed(3) + ', ' + st[1].toFixed(3) +
      (st[3] ? '<br>Задержка публикации: ' + st[3].toFixed(1) + ' с' : '') + '<br>Источник: Blitzortung</div>' + closeBtn;
    placePopup(mx, my);
  }
  /* ─── Клик по «Высоте ВГО»: высота в точке через GetFeatureInfo.
     Формула конвертации — из скрипта источника: код 1 → нет эха, иначе (код−2)/10 км. ─── */
  function heightShowPopup(latlng, mx, my) {
    var seq = ++wxNcGfiSeq;
    var t = new Date(S.ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    var closeBtn = '<span class="popup-close" onclick="document.getElementById(\'pixel-popup\').style.display=\'none\'">✕</span>';
    popupEl.innerHTML = '<div class="popup-header"><div class="popup-label">⏳ Запрос высоты…</div></div>' +
      '<div class="popup-meta">Высота ВГО · 4x4 (BUFR) · кадр ' + t + ' МСК</div>' + closeBtn;
    placePopup(mx, my);
    var live = S.ts >= nowTs();
    var time = live ? null : satIso(S.ts);
    var sts = [{ id: 'bufr_height', label: 'Москва' }, { id: 'bufr_novosib_height', label: 'Новосибирск' }, { id: 'bufr_vlad_height', label: 'Владивосток' }];
    Promise.all(sts.map(function(st) { return wxNcQueryStation(st, latlng, time); })).then(function(res) {
      if (seq !== wxNcGfiSeq || !popupVisible) return;
      var best = null;
      res.forEach(function(r) { if (r.code !== null && r.code !== 255 && (best === null || r.code > best.code)) best = r; });
      var lbl, meta, color;
      if (!best) { lbl = 'Вне зоны покрытия BUFR'; color = 'rgba(128,128,128,0.35)'; meta = 'Станции: Москва · Новосибирск · Владивосток<br>Кадр: ' + t + ' МСК'; }
      else if (best.code <= 1) { lbl = 'Нет эха'; color = 'rgba(128,128,128,0.35)'; meta = 'Слой: <b>Высота ВГО</b> (4x4)<br>Станция: ' + escHtml(best.st.label) + '<br>Кадр: ' + t + ' МСК'; }
      else {
        var km = (best.code - 2) / 10;
        lbl = km.toFixed(1) + ' км';
        color = '#5b8def';
        meta = 'Слой: <b>Высота ВГО</b> (4x4, BUFR)<br>Станция: ' + escHtml(best.st.label) + '<br>Код пикселя: ' + best.code + '<br>Кадр: ' + t + ' МСК';
      }
      popupEl.innerHTML = '<div class="popup-header"><div class="popup-swatch" style="background:' + color + '"></div><div class="popup-label">' + escHtml(lbl) + '</div></div>' +
        '<div class="popup-meta">' + meta + '</div>' + closeBtn;
    });
  }
  map.on('click', function(e) { if (S.ruler.active) return; var p = crosshairMode ? { x: innerWidth / 2, y: innerHeight / 2 } : e.containerPoint; var stLtg = ltgFindNear(p.x, p.y); if (stLtg) { ltgShowPopup(stLtg, p.x, p.y); return; } /* молнии кликабельны поверх ЛЮБОГО слоя, включая спутник */ var ll = crosshairMode ? map.containerPointToLatLng(L.point(p.x, p.y)) : e.latlng; if (S.layer === 'sat' && satProduct === 'height') { heightShowPopup(ll, p.x, p.y); return; } /* высота ВГО в точке */ if (S.layer === 'sat') return; if (S.layer === 'dop') { dopShowPopup(ll, p.x, p.y); return; } /* доплер: скорость в точке */ if (S.layer === 'wx' && radarNcActive()) { /* БЛОК A: тип явления в точке — через GetFeatureInfo */ wxNcShowPopup(ll, p.x, p.y); return; } var block = getBlockAt(p.x, p.y); block ? showPopup(block, p.x, p.y) : hidePopup(); });

  var modal = $('palette-modal'), modalClose = $('modal-close'), modalTabs = document.querySelectorAll('.modal-tabs button'), paletteListContainer = $('palette-list-container'), loadPaletteBtn = $('load-palette-btn'), fileInput = $('file-input'), createPaletteBtn = $('create-palette-btn'), deletePaletteBtn = $('delete-palette-btn'), exportPaletteBtn = $('export-palette-btn'), createForm = $('create-form'), newPalName = $('new-pal-name'), entryVal = $('entry-val'), entryColor = $('entry-color'), entryLabel = $('entry-label'), addEntryBtn = $('add-entry-btn'), entriesList = $('entries-list'), savePaletteBtn = $('save-palette-btn'), cancelCreateBtn = $('cancel-create-btn');
  var currentLayerForModal = 'radar'; var tempEntries = []; var editingIndex = -1; var editingEntryIndex = -1;
  /* a11y: фокус уходит в модалку при открытии и возвращается на вызвавшую кнопку при закрытии */
  var lastFocused = null;
  function focusModal(m) { var mc = m.querySelector('.modal-content'); if (mc) { mc.setAttribute('tabindex', '-1'); mc.focus({ preventScroll: true }); } }
  function restoreFocus() { if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus(); lastFocused = null; }
  /* ─── UI спутниковых палитр в модалке: селект канала + подсказка для RGB-каналов ─── */
  var satPalChSelect = $('sat-pal-ch'), satPalChRow = $('sat-pal-ch-row'), satPalNote = $('sat-pal-note');
  if (satPalChSelect) {
    SAT_CHANNELS.forEach(function(ch) {
      var opt = document.createElement('option');
      opt.value = ch.id; opt.textContent = ch.label + (ch.gray ? '' : ' (цветной)');
      satPalChSelect.appendChild(opt);
    });
    satPalChSelect.addEventListener('change', function() { satModalChId = this.value; syncSatPalUI(); renderPaletteList(); closeForm(); });
  }
  function syncSatPalUI() {
    if (!satPalChRow) return;
    var isSat = currentLayerForModal === 'sat';
    satPalChRow.style.display = isSat ? 'block' : 'none';
    /* Подпись поля порога: для спутника — яркость 0–255, для радара/ОЯ — дБZ */
    if (entryVal) entryVal.placeholder = isSat ? '0–255' : 'дБZ';
    if (!isSat) return;
    if (satPalChSelect.value !== satModalChId) satPalChSelect.value = satModalChId;
    var ch = null;
    for (var i = 0; i < SAT_CHANNELS.length; i++) if (SAT_CHANNELS[i].id === satModalChId) { ch = SAT_CHANNELS[i]; break; }
    satPalNote.textContent = (ch && !ch.gray)
      ? 'Канал уже цветной — палитра применяется только к легенде'
      : 'Порог = яркость пикселя 0–255 (255 — самое холодное/яркое)';
  }
  function openModal() { lastFocused = document.activeElement; modal.classList.add('open'); focusModal(modal); currentLayerForModal = S.layer; satModalChId = SAT_CHANNELS[satChIdx].id; syncSatPalUI(); modalTabs.forEach(function(btn) { btn.classList.toggle('active', btn.dataset.layer === currentLayerForModal); }); renderPaletteList(); closeForm(); editingIndex = -1; editingEntryIndex = -1; tempEntries = []; renderEntries(); }
  function closeModal() { modal.classList.remove('open'); closeForm(); restoreFocus(); }
  function renderPaletteList() { var list = palettes[currentLayerForModal].list; var activeIdx = palettes[currentLayerForModal].activeIdx; var html = ''; list.forEach(function(p, idx) { var activeClass = idx === activeIdx ? 'active' : ''; var builtinBadge = p.builtin ? '<span class="badge">встроенная</span>' : ''; var editBtn = p.builtin ? '' : '<button class="edit-btn" data-idx="' + idx + '" title="Редактировать">✎</button>'; html += '<div class="palette-item ' + activeClass + '" data-idx="' + idx + '">' + '<span class="name">' + escHtml(p.name) + ' ' + builtinBadge + '</span>' + '<div>' + editBtn + (p.builtin ? '' : '<button class="del" data-idx="' + idx + '" title="Удалить">✕</button>') + '</div></div>'; }); paletteListContainer.innerHTML = html; paletteListContainer.querySelectorAll('.palette-item').forEach(function(el) { el.addEventListener('click', function(e) { if (e.target.classList.contains('del') || e.target.classList.contains('edit-btn')) return; var idx = parseInt(this.dataset.idx); palettes[currentLayerForModal].activeIdx = idx; savePalettesToStorage(currentLayerForModal); renderPaletteList(); if (currentLayerForModal === S.layer) { buildLegend(); forceRefresh(); } }); }); paletteListContainer.querySelectorAll('.edit-btn').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var idx = parseInt(this.dataset.idx); startEditingPalette(idx); }); }); paletteListContainer.querySelectorAll('.del').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var idx = parseInt(this.dataset.idx); var list2 = palettes[currentLayerForModal].list; if (list2[idx].builtin) return; if (confirm('Удалить палитру "' + list2[idx].name + '"?')) { list2.splice(idx, 1); if (palettes[currentLayerForModal].activeIdx >= list2.length) palettes[currentLayerForModal].activeIdx = list2.length - 1; if (palettes[currentLayerForModal].activeIdx < 0) palettes[currentLayerForModal].activeIdx = 0; savePalettesToStorage(currentLayerForModal); renderPaletteList(); if (currentLayerForModal === S.layer) { buildLegend(); forceRefresh(); } } }); }); }
  function startEditingPalette(idx) { var list = palettes[currentLayerForModal].list; if (idx < 0 || idx >= list.length) return; var pal = list[idx]; if (pal.builtin) { toast('Встроенную палитру нельзя редактировать'); return; } editingIndex = idx; newPalName.value = pal.name; tempEntries = pal.items.map(function(item) { return { val: item.v, color: '#' + item.r.map(function(c) { return c.toString(16).padStart(2, '0'); }).join(''), label: item.l, r: { r: item.r[0], g: item.r[1], b: item.r[2] } }; }); editingEntryIndex = -1; renderEntries(); createForm.classList.add('open'); savePaletteBtn.textContent = '💾 Обновить'; toast('Редактирование палитры "' + pal.name + '"'); }
  function closeForm() { createForm.classList.remove('open'); editingIndex = -1; editingEntryIndex = -1; tempEntries = []; renderEntries(); savePaletteBtn.textContent = '💾 Сохранить'; newPalName.value = 'Новая палитра'; entryVal.value = '0'; entryColor.value = '#00aaff'; entryLabel.value = 'Осадки'; }
  function renderEntries() { entriesList.innerHTML = ''; tempEntries.forEach(function(e, idx) { var div = document.createElement('div'); div.className = 'entry'; if (editingEntryIndex === idx) { /* цвета — через CSS-классы и токены (светлая тема работает) */ div.innerHTML = `<input type="number" class="edit-val entry-input" value="${e.val}" step="1" style="width:50px"><input type="color" class="edit-color entry-color" value="${e.color}"><input type="text" class="edit-label entry-input" value="${escHtml(e.label)}" style="flex:1"><button class="save-entry-btn" data-idx="${idx}">✓</button>`; } else { div.innerHTML = `<span><span class="color-swatch" style="background:${e.color}"></span> ${e.val} → ${escHtml(e.label)}</span><div><button class="edit-entry-btn" data-idx="${idx}">✎</button><button class="del-entry" data-idx="${idx}">✕</button></div>`; } entriesList.appendChild(div); }); entriesList.querySelectorAll('.save-entry-btn').forEach(function(btn) { btn.addEventListener('click', function() { var idx = parseInt(this.dataset.idx); var entryDiv = this.closest('.entry'); var valInput = entryDiv.querySelector('.edit-val'); var colorInput = entryDiv.querySelector('.edit-color'); var labelInput = entryDiv.querySelector('.edit-label'); var newVal = parseFloat(valInput.value); if (isNaN(newVal)) { toast('Введите число'); return; } var newColor = colorInput.value; var newLabel = labelInput.value.trim() || 'без метки'; var rgb = hexToRgb(newColor); if (!rgb) { toast('Неверный цвет'); return; } tempEntries[idx] = { val: newVal, color: newColor, label: newLabel, r: rgb }; editingEntryIndex = -1; renderEntries(); }); }); entriesList.querySelectorAll('.edit-entry-btn').forEach(function(btn) { btn.addEventListener('click', function() { var idx = parseInt(this.dataset.idx); editingEntryIndex = idx; renderEntries(); }); }); entriesList.querySelectorAll('.del-entry').forEach(function(btn) { btn.addEventListener('click', function() { var idx = parseInt(this.dataset.idx); tempEntries.splice(idx, 1); if (editingEntryIndex === idx) editingEntryIndex = -1; else if (editingEntryIndex > idx) editingEntryIndex--; renderEntries(); }); }); }
  function addEntry() { var v = parseFloat(entryVal.value); if (isNaN(v)) { toast('Введите число'); return; } var color = entryColor.value; var label = entryLabel.value.trim() || 'без метки'; var rgb = hexToRgb(color); if (!rgb) { toast('Неверный цвет'); return; } tempEntries.push({ val: v, color: color, label: label, r: rgb }); renderEntries(); entryVal.value = ''; entryLabel.value = ''; var maxVal = tempEntries.reduce(function(mx, e) { return Math.max(mx, e.val); }, 0); entryVal.value = (maxVal + 5); }
  function hexToRgb(hex) { var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null; }
  function savePalette() { var name = newPalName.value.trim() || 'Без названия'; if (tempEntries.length === 0) { toast('Добавьте хотя бы одну запись'); return; } var sorted = tempEntries.slice().sort(function(a, b) { return b.val - a.val; }); var items = sorted.map(function(e) { return { v: e.val, r: [e.r.r, e.r.g, e.r.b], l: e.label }; }); if (editingIndex >= 0) { var list = palettes[currentLayerForModal].list; if (editingIndex >= list.length) { toast('Ошибка: палитра не найдена'); return; } if (list[editingIndex].builtin) { toast('Нельзя редактировать встроенную палитру'); return; } list[editingIndex].name = name; list[editingIndex].items = items; savePalettesToStorage(currentLayerForModal); renderPaletteList(); if (currentLayerForModal === S.layer) { buildLegend(); forceRefresh(); } toast('Палитра "' + name + '" обновлена'); closeForm(); } else { var newPal = { name: name, items: items, builtin: false }; palettes[currentLayerForModal].list.push(newPal); palettes[currentLayerForModal].activeIdx = palettes[currentLayerForModal].list.length - 1; savePalettesToStorage(currentLayerForModal); renderPaletteList(); if (currentLayerForModal === S.layer) { buildLegend(); forceRefresh(); } toast('Палитра "' + name + '" сохранена'); closeForm(); } }
  function exportPalette() { var layer = currentLayerForModal || S.layer; var list = palettes[layer].list; var idx = palettes[layer].activeIdx; if (!list || list.length === 0 || idx >= list.length) { toast('Нет палитры для экспорта'); return; } var pal = list[idx]; var content = generatePalFile(pal.items, pal.name, layer); var blob = new Blob([content], { type: 'text/plain;charset=utf-8' }); var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = (pal.name || 'palette') + '.pal'; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); toast('Палитра "' + pal.name + '" экспортирована'); }
  function generatePalFile(items, name, layer) { var sorted = items.slice().sort(function(a, b) { return a.v - b.v; }); var lines = []; lines.push('Product: ' + (layer === 'radar' ? 'BR' : (layer === 'sat' ? 'SAT' : 'WX'))); lines.push('Units: ' + (layer === 'sat' ? 'brightness' : 'dBZ')); lines.push('Scale: 1'); lines.push('Offset: 0'); lines.push('Step: 5'); lines.push('RF: 0 0 0'); lines.push(''); for (var i = 0; i < sorted.length; i++) { var p = sorted[i]; var r = p.r[0], g = p.r[1], b = p.r[2]; lines.push('Color: ' + p.v + ' ' + r + ' ' + g + ' ' + b); } return lines.join('\n'); }
  function loadPaletteFromFile(file) { var reader = new FileReader(); reader.onload = function(e) { try { var content = e.target.result; var data = parsePaletteFile(content); if (data) { var name = file.name.replace(/\.[^.]+$/, '') || 'Загруженная'; var newPal = { name: name, items: data, builtin: false }; palettes[currentLayerForModal].list.push(newPal); palettes[currentLayerForModal].activeIdx = palettes[currentLayerForModal].list.length - 1; savePalettesToStorage(currentLayerForModal); renderPaletteList(); if (currentLayerForModal === S.layer) { buildLegend(); forceRefresh(); } toast('Палитра загружена'); } else { toast('Ошибка парсинга файла'); } } catch (err) { toast('Ошибка: ' + err.message); } }; reader.readAsText(file); }
  function parsePaletteFile(text) { try { var parsed = JSON.parse(text); if (Array.isArray(parsed) && parsed.length && parsed[0].v !== undefined && parsed[0].r && parsed[0].l) { return parsed; } } catch (e) {} var lines = text.split(/\r?\n/).filter(function(line) { return line.trim().length > 0; }); var items = []; var inTable = false; for (var i = 0; i < lines.length; i++) { var line = lines[i].trim(); if (/^ColorTable\s*\{/.test(line)) { inTable = true; continue; } if (/^\}/.test(line)) { inTable = false; continue; } if (!inTable) continue; var match = line.match(/Color\s*\[\s*([\d.]+)\s*\]\s*=\s*(rgb|gradient)\s*\(\s*([^)]+)\s*\)/i); if (match) { var v = parseFloat(match[1]); var type = match[2].toLowerCase(); var params = match[3].split(/\s*,\s*/).filter(function(s) { return s.length > 0; }); if (type === 'rgb' && params.length >= 3) { var r = parseInt(params[0]); var g = parseInt(params[1]); var b = parseInt(params[2]); if (!isNaN(r) && !isNaN(g) && !isNaN(b)) { items.push({ v: v, r: [r, g, b], l: '>= ' + v + ' dBZ' }); } } else if (type === 'gradient' && params.length >= 6) { var r2 = parseInt(params[1]), g2 = parseInt(params[2]), b2 = parseInt(params[3]); if (!isNaN(r2) && !isNaN(g2) && !isNaN(b2)) { items.push({ v: v, r: [r2, g2, b2], l: '>= ' + v + ' dBZ' }); } } } } if (items.length > 0) { items.sort(function(a, b) { return b.v - a.v; }); return items; } var colorLines = []; var product = null; for (var j = 0; j < lines.length; j++) { var line2 = lines[j].trim(); if (/^Product:/i.test(line2)) { product = line2; } if (/^Color:/i.test(line2)) { colorLines.push(line2); } } if (colorLines.length > 0) { var newItems = []; for (var k = 0; k < colorLines.length; k++) { var parts = colorLines[k].split(/\s+/); if (parts.length >= 5) { var val = parseFloat(parts[1]); var r3 = parseInt(parts[2]); var g3 = parseInt(parts[3]); var b3 = parseInt(parts[4]); if (!isNaN(val) && !isNaN(r3) && !isNaN(g3) && !isNaN(b3)) { newItems.push({ v: val, r: [r3, g3, b3], l: val + ' dBZ' }); } } } if (newItems.length > 0) { newItems.sort(function(a, b) { return b.v - a.v; }); return newItems; } } var csvItems = []; for (var m = 0; m < lines.length; m++) { var line3 = lines[m].trim(); var parts2 = line3.split(/\s*,\s*/); if (parts2.length >= 5) { var v2 = parseFloat(parts2[0]); if (isNaN(v2)) continue; var r4 = parseInt(parts2[1]), g4 = parseInt(parts2[2]), b4 = parseInt(parts2[3]); if (isNaN(r4) || isNaN(g4) || isNaN(b4)) continue; var label = parts2.slice(4).join(',').trim() || 'без метки'; csvItems.push({ v: v2, r: [r4, g4, b4], l: label }); } else { var m2 = line3.match(/^([\d.]+)\s+#([a-fA-F0-9]{6})\s+(.+)$/); if (m2) { var v3 = parseFloat(m2[1]); if (isNaN(v3)) continue; var rgb = hexToRgb('#' + m2[2]); if (!rgb) continue; csvItems.push({ v: v3, r: [rgb.r, rgb.g, rgb.b], l: m2[3].trim() }); } } } if (csvItems.length === 0) return null; csvItems.sort(function(a, b) { return b.v - a.v; }); return csvItems; }

  modalClose.addEventListener('click', closeModal);
  modalTabs.forEach(function(btn) { btn.addEventListener('click', function() { currentLayerForModal = this.dataset.layer; modalTabs.forEach(function(b) { b.classList.toggle('active', b === btn); }); syncSatPalUI(); renderPaletteList(); closeForm(); }); });
  loadPaletteBtn.addEventListener('click', function() { fileInput.click(); });
  fileInput.addEventListener('change', function(e) { if (this.files && this.files[0]) { loadPaletteFromFile(this.files[0]); } this.value = ''; });
  exportPaletteBtn.addEventListener('click', exportPalette);
  createPaletteBtn.addEventListener('click', function() { closeForm(); editingIndex = -1; editingEntryIndex = -1; newPalName.value = 'Новая палитра'; tempEntries = []; renderEntries(); createForm.classList.add('open'); savePaletteBtn.textContent = '💾 Сохранить'; });
  cancelCreateBtn.addEventListener('click', function() { closeForm(); });
  addEntryBtn.addEventListener('click', addEntry);
  document.querySelectorAll('#entry-val, #entry-label').forEach(function(inp) { inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') addEntry(); }); });
  savePaletteBtn.addEventListener('click', savePalette);
  deletePaletteBtn.addEventListener('click', function() { var list = palettes[currentLayerForModal].list; var idx = palettes[currentLayerForModal].activeIdx; if (idx >= list.length) return; if (list[idx].builtin) { toast('Нельзя удалить встроенную палитру'); return; } if (confirm('Удалить активную палитру "' + list[idx].name + '"?')) { list.splice(idx, 1); if (palettes[currentLayerForModal].activeIdx >= list.length) palettes[currentLayerForModal].activeIdx = list.length - 1; if (palettes[currentLayerForModal].activeIdx < 0) palettes[currentLayerForModal].activeIdx = 0; savePalettesToStorage(currentLayerForModal); renderPaletteList(); if (currentLayerForModal === S.layer) { buildLegend(); forceRefresh(); } } });
  $('btn-palettes').addEventListener('click', openModal);

  var opacitySlider = $('opacity-slider');
  var opacityVal = $('opacity-val');
  if (opacitySlider) {
    canvas.style.opacity = parseInt(opacitySlider.value) / 100;
    opacitySlider.addEventListener('input', function() {
      var val = parseInt(this.value);
      if (S.layer === 'sat') {
        satOpacityMem = val; /* сессионное значение спутника — переживает смену кадра/канала */
        if (eumetsatLayer) eumetsatLayer.setOpacity(val / 100);
        if (prodWmsLayer) prodWmsLayer.setOpacity(val / 100); /* WMS-продукт COMPOSITE */
        satUpdateChip();
      } else {
        canvas.style.opacity = val / 100;
        if (radarNcLayer && S.dbzVisible) radarNcLayer.setOpacity(val / 100); /* WMS-радар nowcast */
        if (S.dbzVisible) wxNcExtras.forEach(function(l) { l.setOpacity(val / 100); }); /* доп. станции ОЯ BUFR */
      }
      opacityVal.textContent = val + '%';
      retrig(opacityVal, 'bump'); /* лёгкий отклик значения */
      saveViewDebounced();
    });
  }

  var helpModal = $('help-modal');
  var helpClose = $('help-close');
  function closeHelp() { if (helpModal) { helpModal.classList.remove('open'); restoreFocus(); } }
  if ($('btn-help')) { $('btn-help').addEventListener('click', function() { if (helpModal) { lastFocused = document.activeElement; helpModal.classList.add('open'); focusModal(helpModal); } }); }
  if (helpClose) { helpClose.addEventListener('click', closeHelp); }
  /* Клик по фону закрывает модалки */
  modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });
  if (helpModal) { helpModal.addEventListener('click', function(e) { if (e.target === helpModal) closeHelp(); }); }

  /* ─── Смена темы: мягкий кроссфейд тайл-слоёв (новый слой проявляется поверх ~350мс) ─── */
  function swapBaseLayer(toLayer, fromLayer) {
    if (!fromLayer) { toLayer.addTo(map); return; }
    if (REDUCE_MOTION) { map.removeLayer(fromLayer); toLayer.addTo(map); return; }
    toLayer.setOpacity(0); toLayer.addTo(map);
    var t0 = performance.now(), D = 350;
    (function step() {
      var k = Math.min(1, (performance.now() - t0) / D);
      toLayer.setOpacity(k);
      if (k < 1) requestAnimationFrame(step);
      else { if (map.hasLayer(fromLayer)) map.removeLayer(fromLayer); fromLayer.setOpacity(1); }
    })();
  }

  /* ─── БЛОК C: три темы — Тёмная → Светлая → Схема (Voyager, «как Google Maps») → цикл ───
     «Схема» — светлая карта, поэтому UI тоже светлый (body.light-theme):
     тёмные панели на светлой карте выглядят чужеродно, а светлая тема уже готова. */
  var THEME_ORDER = ['dark', 'light', 'scheme'];
  var currentTheme = 'dark';
  function themeLayer(name) { return name === 'dark' ? darkTileLayer : (name === 'light' ? lightTileLayer : voyagerTileLayer); }
  function themeLabel(name) { return name === 'dark' ? 'Тёмная' : (name === 'light' ? 'Светлая' : 'Схема'); }
  function activeBaseLayer() {
    if (map.hasLayer(darkTileLayer)) return darkTileLayer;
    if (map.hasLayer(lightTileLayer)) return lightTileLayer;
    if (map.hasLayer(voyagerTileLayer)) return voyagerTileLayer;
    return null;
  }
  function applyTheme(name, animate) {
    if (THEME_ORDER.indexOf(name) < 0) name = 'dark'; /* обратная совместимость с mapView */
    var to = themeLayer(name), from = activeBaseLayer();
    currentTheme = name;
    document.body.classList.toggle('light-theme', name !== 'dark');
    if ($('btn-theme')) $('btn-theme').textContent = 'Тема: ' + themeLabel(name);
    if (from !== to) {
      if (animate) swapBaseLayer(to, from);
      else { if (from) map.removeLayer(from); to.addTo(map); }
    }
    updateSatBackdrop(animate); /* в sat-режиме: dark — подложка не нужна, light/scheme — нужна */
  }
  if ($('btn-theme')) { $('btn-theme').addEventListener('click', function() { var next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme) + 1) % THEME_ORDER.length]; applyTheme(next, true); toast('Тема: ' + themeLabel(next)); saveViewDebounced(); }); }

  /* На таче приглушаем панели во время перетаскивания карты — карту видно целиком */
  if (IS_MOBILE) {
    var dragDimTmr = null;
    map.on('movestart', function() { if (document.querySelector('.dropdown-menu.visible')) return; /* дропдаун открыт — не глушим */ clearTimeout(dragDimTmr); document.body.classList.add('map-drag'); });
    map.on('moveend', function() { clearTimeout(dragDimTmr); dragDimTmr = setTimeout(function() { document.body.classList.remove('map-drag'); }, 250); });
  }

  /* ═══ БЛОК A: экспорт данных радара/спутника с видимой области ═══ */

  /* Имя файла: tatmeteo_{YYYY-MM-DD_HH-MM}_z{zoom}_{lat}_{lon} (время кадра МСК, без кириллицы) */
  function exportBaseName() {
    var s = new Date(S.ts * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }); /* 'YYYY-MM-DD HH:MM:SS' */
    var c = map.getCenter();
    return 'tatmeteo_' + s.slice(0, 10) + '_' + s.slice(11, 16).replace(':', '-') + '_z' + map.getZoom() + '_' + c.lat.toFixed(3) + '_' + c.lng.toFixed(3);
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
    toast('Экспортировано: ' + filename);
  }
  function dataUrlToU8(du) {
    var bin = atob(du.slice(du.indexOf(',') + 1));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  /* ─── Мини-ZIP (метод STORE, без сжатия): PNG уже сжат, CSV/JSON крошечные.
     Собственные ~50 строк вместо CDN-библиотеки (fflate) — ноль зависимостей,
     формат тривиален, deflate дал бы выигрыш <2% на наших данных ─── */
  var crcTable = (function() { var t = [], c; for (var n = 0; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function makeZip(files) { /* files: [{name: 'a.png', data: Uint8Array}] */
    var enc = new TextEncoder(), chunks = [], central = [], offset = 0;
    files.forEach(function(f) {
      var nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      var lh = new Uint8Array(30 + nm.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, sz, true); lv.setUint32(22, sz, true);
      lv.setUint16(26, nm.length, true);
      lh.set(nm, 30);
      chunks.push(lh, f.data);
      var ch = new Uint8Array(46 + nm.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, sz, true); cv.setUint32(24, sz, true);
      cv.setUint16(28, nm.length, true); cv.setUint32(42, offset, true);
      ch.set(nm, 46);
      central.push(ch);
      offset += lh.length + sz;
    });
    var cdSize = 0; central.forEach(function(c) { cdSize += c.length; });
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [eocd]), { type: 'application/zip' });
  }

  /* ─── Рендер видимой области радара в offscreen-canvas (из S.cache, как doRender, с DPR) ─── */
  function renderRadarToCanvas() {
    var W = Math.round(innerWidth * DPR), H = Math.round(innerHeight * DPR);
    var oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    var octx = oc.getContext('2d');
    octx.setTransform(DPR, 0, 0, DPR, 0, 0); octx.imageSmoothingEnabled = false;
    var tiles = visTiles(), missing = 0;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i], entry = S.cache.get(CK(t.x, t.y));
      if (entry && entry.canvas) { var r = tileRect(t.x, t.y); if (r.sw > 0 && r.sh > 0) octx.drawImage(entry.canvas, r.sx, r.sy, r.sw, r.sh); }
      else missing++;
    }
    return { canvas: oc, missing: missing, total: tiles.length, w: W, h: H };
  }

  /* ─── Снимок спутника: перерисовываем видимые WMS-тайлы Leaflet в canvas ─── */
  function renderSatToCanvas() {
    if (!eumetsatLayer || !eumetsatLayer._tiles) return null;
    var W = Math.round(innerWidth * DPR), H = Math.round(innerHeight * DPR);
    var oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    var octx = oc.getContext('2d'); octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var tiles = eumetsatLayer._tiles, drawn = 0;
    Object.keys(tiles).forEach(function(k) {
      var t = tiles[k];
      if (!t.current || !t.loaded || !t.el || !t.el.complete || !t.el.naturalWidth) return;
      var c = t.coords, sz = 256;
      var nw = map.unproject(L.point(c.x * sz, c.y * sz), c.z);
      var se = map.unproject(L.point((c.x + 1) * sz, (c.y + 1) * sz), c.z);
      var p1 = map.latLngToContainerPoint(nw), p2 = map.latLngToContainerPoint(se);
      try { octx.drawImage(t.el, p1.x, p1.y, p2.x - p1.x, p2.y - p1.y); drawn++; } catch (e) {}
    });
    return drawn > 0 ? { canvas: oc, missing: 0, total: drawn, w: W, h: H } : null;
  }

  /* ═══ БЛОК A: композит «карта + слой» ═══ */

  /* Универсальная отрисовка видимых тайлов любого Leaflet-слоя в контекст (CSS-пиксели) */
  function drawTileLayerTo(octx, layer) {
    if (!layer || !layer._tiles) return 0;
    var tiles = layer._tiles, drawn = 0;
    Object.keys(tiles).forEach(function(k) {
      var t = tiles[k];
      if (!t.current || !t.loaded || !t.el || !t.el.complete || !t.el.naturalWidth) return;
      var c = t.coords, sz = 256;
      var nw = map.unproject(L.point(c.x * sz, c.y * sz), c.z);
      var se = map.unproject(L.point((c.x + 1) * sz, (c.y + 1) * sz), c.z);
      var p1 = map.latLngToContainerPoint(nw), p2 = map.latLngToContainerPoint(se);
      try { octx.drawImage(t.el, p1.x, p1.y, p2.x - p1.x, p2.y - p1.y); drawn++; } catch (e) {}
    });
    return drawn;
  }

  /* Базовая карта активной темы (+ тёмная подложка спутника, если она на карте) */
  function renderBasemapToCanvas(octx) {
    /* Фон-заливка на случай недогруженных тайлов базы — вместо «дыр» */
    octx.save(); octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.fillStyle = document.body.classList.contains('light-theme') ? '#e9eef3' : '#323441';
    octx.fillRect(0, 0, 1e6, 1e6); octx.restore();
    var n = drawTileLayerTo(octx, activeBaseLayer());
    if (satBackdropActive()) n += drawTileLayerTo(octx, satBackdropLayer); /* тёмная подложка спутника поверх базы — как на экране */
    return n;
  }

  /* Композит: база (непрозрачно) + данные с той же прозрачностью, что на экране.
     Прозрачность «впечатывается» в пиксели через globalAlpha. */
  /* ═══ БЛОК B: легенда, встроенная в композит «карта + слой» ═══
     Данные берутся из ТОЙ ЖЕ логики, что buildLegend() (getCurrentPaletteItems /
     SAT_CHANNELS[].legend / satActivePalette) — без дублирования таблиц. */
  var LEGEND_POS = 'bottom-right'; /* привычный угол легенды; левый низ занят чипом,
                                      верх — тулбаром; можно 'top-right'/'bottom-left' */

  /* Сбор строк легенды для канваса: {title, grad[], gradCaps[], rows[[css-цвет, подпись]], notes[]} */
  function collectLegendData() {
    /* Грозовые продукты — своя легенда в экспорт-композите */
    if (S.layer === 'sat' && satProduct) {
      if (satProduct === 'height') {
        return { title: 'ВЫСОТА ВГО · BUFR (ДМРЛ)', grad: null, gradCaps: null,
          rows: HEIGHT_DISPLAY_PALETTE.map(function(p) { return ['rgb(' + p[1].join(',') + ')', p[0] + '–' + (p[0] + 1) + ' км']; }),
          notes: ['Фактическая палитра 4x4 · шаг 10 мин'] };
      }
      if (satProduct === 'composite') {
        return { title: 'COMPOSITE · ОТРАЖАЕМОСТЬ dBZ', grad: null, gradCaps: null,
          rows: BUILTIN_RADAR.map(function(e2) { return ['rgb(' + e2.r.join(',') + ')', e2.l]; }),
          notes: ['Композит · 4x4 (' + COMPOSITE_REGIONS[compositeRegionIdx].label + ')'] };
      }
      if (satProduct === 'cape') {
        return { title: 'CAPE · Дж/кг', grad: ['#4ade80', '#fde047', '#f97316', '#dc2626', '#a21caf'], gradCaps: ['100', '3000+'],
          rows: [['#4ade80', '100–500'], ['#fde047', '500–1000'], ['#f97316', '1000–2000'], ['#dc2626', '2000–3000'], ['#a21caf', '>3000']],
          notes: ['Модель Open-Meteo'] };
      }
      if (satProduct === 'cin') {
        return { title: 'CIN · Дж/кг', grad: ['#93c5fd', '#3b82f6', '#1d4ed8', '#6b21a8'], gradCaps: ['15', '200+'],
          rows: [['#93c5fd', '15–50'], ['#3b82f6', '50–100'], ['#1d4ed8', '100–200'], ['#6b21a8', '>200']],
          notes: ['Модель Open-Meteo'] };
      }
      return { title: 'SUPERCELL · ОЦЕНКА', grad: null, gradCaps: null,
        rows: [['#fde047', '1 — слабые условия'], ['#f97316', '2 — умеренные'], ['#dc2626', '3 — сильные']],
        notes: ['CAPE + сдвиг ветра · оценка, не SCP NOAA · Open-Meteo'] };
    }
    if (S.layer === 'sat') {
      var ch = SAT_CHANNELS[satChIdx];
      var out = { title: 'СПУТНИК · ' + ch.label.toUpperCase(), grad: null, gradCaps: null, rows: [], notes: [] };
      var pal = satActivePalette();
      if (pal && pal.items && pal.items.length && !pal.legendOnly) {
        /* как в buildLegend: градиент по стопам палитры (v по возрастанию) + строки */
        var asc = pal.items.slice().sort(function(a, b) { return a.v - b.v; });
        out.grad = asc.map(function(it) { return 'rgb(' + it.r.join(',') + ')'; });
        out.gradCaps = ['тепло', 'холодно'];
        out.rows = pal.items.map(function(it) { return ['rgb(' + it.r.join(',') + ')', it.l]; });
        if (pal.name) out.notes.push('Палитра: ' + pal.name);
      } else {
        var lg = ch.legend || {};
        if (lg.grad) { out.grad = lg.grad; out.gradCaps = ['холодно', 'тепло']; }
        (lg.rows || []).forEach(function(r) { out.rows.push([r[0], r[1]]); });
      }
      out.notes.push('Прозрачность слоя: 50%');
      out.notes.push('© EUMETSAT');
      return out;
    }
    if (S.layer === 'dop') {
      return { title: 'ДОПЛЕР · РАДИАЛЬНАЯ СКОРОСТЬ', grad: DOP_DISPLAY_PALETTE.map(function(p) { return 'rgb(' + p[1].join(',') + ')'; }), gradCaps: ['−50 м/с · к радару', '+50 м/с · от радара'],
        rows: DOP_DISPLAY_PALETTE.map(function(p) { return ['rgb(' + p[1].join(',') + ')', (p[0] > 0 ? '+' : '') + p[0] + ' м/с']; }),
        notes: ['Шаг 5 м/с · ДМРЛ 4x4 · ' + DOP_HEIGHTS[dopHeightIdx].label] };
    }
    var items = getCurrentPaletteItems();
    var o = { title: S.layer === 'radar' ? 'ОТРАЖАЕМОСТЬ dBZ' : 'ПОГОДНЫЕ ЯВЛЕНИЯ', grad: null, gradCaps: null, rows: [], notes: [] };
    if (S.layer === 'wx' && radarSource === 'nowcast') {
      /* БЛОК A: в композит — фактическая палитра ОЯ-BUFR (как на экране) */
      o.title = 'ПОГОДНЫЕ ЯВЛЕНИЯ · BUFR';
      WX_NC_PALETTE.forEach(function(p) { o.rows.push([p[1], p[2]]); });
      o.notes.push('4x4 · станции: Москва/Новосибирск/Владивосток');
      return o;
    }
    if (S.layer === 'radar') o.notes.push(radarNcActive() ? 'Источник: 4x4 (ДМРЛ)' : 'Источник: rainradar.ru');
    items.forEach(function(p) { o.rows.push(['rgb(' + p.r.join(',') + ')', p.l]); });
    try { var pl = palettes[S.layer]; var pn = pl.list[pl.activeIdx].name; if (pn) o.notes.push('Палитра: ' + pn); } catch (e) {}
    return o;
  }

  /* Скруглённый прямоугольник (fallback для браузеров без ctx.roundRect) */
  function rrPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Отрисовка легенды в контекст композита. Контекст уже в CSS-пикселях
     (setTransform(DPR,…) активен) — размеры считаем от innerWidth/innerHeight.
     Легенда — часть растровых пикселей: .pgw НЕ меняется, геопривязка по краям
     изображения сохраняется. */
  function drawLegendToCanvas(octx) {
    var data = collectLegendData();
    var FONT_ROW = '600 11px Manrope, system-ui, sans-serif';
    var FONT_TITLE = '700 11px Manrope, system-ui, sans-serif';
    var FONT_NOTE = '600 9px Manrope, system-ui, sans-serif';
    var PAD = 12, LINE = 17, SW = 10, GAP = 7, RAD = 10, MARGIN = 14;

    /* wx-палитра — 20 строк: в две колонки по ≤10, длиннее 24 — обрезаем с «…» */
    var rows = data.rows.slice(0, 24);
    var truncated = data.rows.length > 24;
    var perCol = rows.length > 10 ? Math.ceil(rows.length / 2) : rows.length;
    var cols = rows.length > 10 ? 2 : 1;

    octx.save();
    /* Ширины колонок по реальному тексту */
    octx.font = FONT_ROW;
    var colW = [0, 0];
    rows.forEach(function(r, i) {
      var c = Math.floor(i / perCol);
      colW[c] = Math.max(colW[c], SW + 6 + octx.measureText(r[1]).width);
    });
    octx.font = FONT_TITLE;
    var titleW = octx.measureText(data.title).width;
    octx.font = FONT_NOTE;
    var noteW = 0;
    data.notes.forEach(function(n) { noteW = Math.max(noteW, octx.measureText(n).width); });
    if (truncated) data.notes.unshift('… показаны первые 24 строки');

    var contentW = Math.max(titleW, noteW, colW[0] + (cols > 1 ? GAP * 2 + colW[1] : 0), data.grad ? 120 : 0);
    var gradH = data.grad ? (8 + 13) : 0; /* полоса + подписи холодно/тепло */
    var panelW = contentW + PAD * 2;
    var panelH = PAD * 2 + 15 /* заголовок */ + 6 + gradH + perCol * LINE + (data.notes.length ? 4 + data.notes.length * 12 : 0);

    /* Позиция по LEGEND_POS (по умолчанию правый нижний угол) */
    var x = LEGEND_POS.indexOf('right') >= 0 ? innerWidth - panelW - MARGIN : MARGIN;
    var y = LEGEND_POS.indexOf('bottom') >= 0 ? innerHeight - panelH - MARGIN : MARGIN;

    /* Панель: тёмное стекло — читаемо на любой карте и любой теме */
    rrPath(octx, x, y, panelW, panelH, RAD);
    octx.fillStyle = 'rgba(18, 20, 28, 0.78)';
    octx.fill();
    octx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    octx.lineWidth = 1;
    octx.stroke();

    var cx = x + PAD, cy = y + PAD + 10;
    /* Заголовок */
    octx.font = FONT_TITLE;
    octx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    octx.fillText(data.title, cx, cy);
    cy += 6 + 5;

    /* Градиентная шкала (спутник) */
    if (data.grad) {
      var g = octx.createLinearGradient(cx, 0, cx + contentW, 0);
      data.grad.forEach(function(cstop, i) { g.addColorStop(data.grad.length === 1 ? 0 : i / (data.grad.length - 1), cstop); });
      rrPath(octx, cx, cy, contentW, 8, 4);
      octx.fillStyle = g; octx.fill();
      octx.font = FONT_NOTE;
      octx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      octx.fillText(data.gradCaps[0], cx, cy + 18);
      octx.fillText(data.gradCaps[1], cx + contentW - octx.measureText(data.gradCaps[1]).width, cy + 18);
      cy += gradH + 2;
    }

    /* Строки (1–2 колонки): цветной квадрат + подпись */
    octx.font = FONT_ROW;
    var rowsTop = cy;
    rows.forEach(function(r, i) {
      var c = Math.floor(i / perCol), j = i % perCol;
      var rx = cx + (c === 1 ? colW[0] + GAP * 2 : 0);
      var ry = rowsTop + j * LINE;
      octx.fillStyle = r[0];
      rrPath(octx, rx, ry, SW, SW, 2.5); octx.fill();
      octx.strokeStyle = 'rgba(0,0,0,0.35)'; octx.lineWidth = 0.5; octx.stroke();
      octx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      octx.fillText(r[1], rx + SW + 6, ry + SW - 1);
    });
    cy = rowsTop + perCol * LINE;

    /* Примечания (прозрачность, © EUMETSAT, имя палитры) */
    if (data.notes.length) {
      octx.font = FONT_NOTE;
      octx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      data.notes.forEach(function(n, i) { octx.fillText(n, cx, cy + 8 + i * 12); });
    }
    octx.restore();
  }

  function renderCompositeToCanvas() {
    var W = Math.round(innerWidth * DPR), H = Math.round(innerHeight * DPR);
    var oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    var octx = oc.getContext('2d');
    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    renderBasemapToCanvas(octx);
    var missing = 0, total = 0;
    if (S.layer === 'sat') {
      if (satProduct) {
        /* Грозовой продукт вместо снимка: WMS-композит из тайлов, сетка — прямоугольниками */
        var pdE = prodDef();
        if (pdE.kind === 'wms' && prodWmsLayer) {
          octx.save(); octx.globalAlpha = satOpacityMem / 100;
          total = drawTileLayerTo(octx, prodWmsLayer);
          octx.restore();
        } else if (pdE.kind === 'grid') {
          total = drawProdCells(octx);
        }
      } else {
        var sat = renderSatToCanvas();
        if (sat) { octx.save(); octx.setTransform(1, 0, 0, 1, 0, 0); octx.globalAlpha = satOpacityMem / 100; octx.drawImage(sat.canvas, 0, 0); octx.restore(); total = sat.total; }
      }
    } else if (S.layer === 'dop') {
      if (nowcastLayer) {
        /* Реальный доплер: WMS-тайлы nowcast в пиксели (как спутник) */
        octx.save(); octx.globalAlpha = 0.85;
        drawTileLayerTo(octx, nowcastLayer);
        octx.restore();
      }
    } else if (radarNcActive()) {
      /* dBZ с nowcast: WMS-тайлы в пиксели (прозрачность слоя уже включает слайдер) */
      if (S.dbzVisible && radarNcLayer) {
        octx.save(); octx.globalAlpha = (parseInt($('opacity-slider').value) || 100) / 100;
        drawTileLayerTo(octx, radarNcLayer);
        wxNcExtras.forEach(function(l) { drawTileLayerTo(octx, l); }); /* доп. станции ОЯ BUFR */
        octx.restore();
      }
    } else {
      var rc = renderRadarToCanvas();
      octx.save(); octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.globalAlpha = (parseInt($('opacity-slider').value) || 100) / 100; /* как на экране */
      octx.imageSmoothingEnabled = false;
      octx.drawImage(rc.canvas, 0, 0);
      octx.restore();
      missing = rc.missing; total = rc.total;
    }
    if (ltg.on && ltg.strikes.length) drawLtgToCtx(octx); /* молнии — в пиксели композита */
    /* Легенда — последней, поверх базы/подложки/данных (только в композите) */
    try { drawLegendToCanvas(octx); } catch (e) { console.warn('[export] легенда не отрисована:', e); }
    return { canvas: oc, missing: missing, total: total, w: W, h: H };
  }

  /* ─── World-файл (.pgw) в EPSG:3857: строки A, B, C, D(отриц.), E, F.
     Веб-меркатор линеен в метрах → геопривязка точная (в QGIS задать слою CRS EPSG:3857) ─── */
  function makeWorldFile(W, H) {
    var b = map.getBounds();
    var nw = L.CRS.EPSG3857.project(b.getNorthWest()); /* метры */
    var se = L.CRS.EPSG3857.project(b.getSouthEast());
    var A = (se.x - nw.x) / W;         /* размер пикселя по X */
    var D = -((nw.y - se.y) / H);      /* по Y — отрицательный (строки идут вниз) */
    var E = nw.x + A / 2, F = nw.y + D / 2; /* центр верхнего левого пикселя */
    return [A, 0, 0, D, E, F].map(function(v) { return Number(v).toFixed(6); }).join('\n') + '\n';
  }

  function exportMeta(rc, isComposite) {
    var b = map.getBounds(), c = map.getCenter();
    var palName = '';
    try {
      if (S.layer === 'sat') { var sp = satActivePalette(); palName = sp ? sp.name : ''; }
      else { var pl = palettes[S.layer]; palName = pl.list[pl.activeIdx].name; }
    } catch (e) {}
    return {
      generator: 'Tatmeteo',
      frame_time_msk: new Date(S.ts * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      layer: S.layer,
      sat_channel: S.layer === 'sat' && !satProduct ? SAT_CHANNELS[satChIdx].id : undefined,
      product: S.layer === 'sat' && satProduct ? satProduct : undefined,
      product_source: S.layer === 'sat' && satProduct
        ? (satProduct === 'composite' ? '4x4 (' + COMPOSITE_REGIONS[compositeRegionIdx].id + ')'
          : (satProduct === 'height' ? '4x4 (ДМРЛ BUFR — высота ВГО)'
            : 'Open-Meteo (модель, час ' + ((prodGrid.times && prodGrid.times[prodGrid.hourIdx]) || '—') + ' UTC)'))
        : undefined,
      composite: isComposite ? true : undefined,
      basemap_theme: isComposite ? currentTheme : undefined,
      legend: isComposite ? true : undefined,       /* легенда встроена в пиксели композита */
      lightning: ltg.on ? true : undefined,         /* молнии вписаны в пиксели */
      doppler: S.layer === 'dop' ? true : undefined,
      radar_source: (S.layer === 'radar' || S.layer === 'wx') ? (radarNcActive() ? '4x4 (' + (S.layer === 'wx' ? 'BUFR: ' + WX_NC_LAYERS.map(function(l) { return l.id; }).join(' + ') : RADAR_NC_LAYERS[radarNcIdx].id) + ')' : 'rainradar.ru') : undefined,
      doppler_source: S.layer === 'dop' ? '4x4 — радиальная скорость ДМРЛ (' + DOP_HEIGHTS[dopHeightIdx].label + ')' : undefined,
      legend_pos: isComposite ? LEGEND_POS : undefined,
      sat_backdrop: isComposite && satBackdropActive() ? 'dark_all под спутником' : undefined,
      zoom: map.getZoom(),
      center: [+c.lat.toFixed(5), +c.lng.toFixed(5)],
      bounds_deg: [[+b.getSouth().toFixed(5), +b.getWest().toFixed(5)], [+b.getNorth().toFixed(5), +b.getEast().toFixed(5)]],
      crs: 'EPSG:3857 (world-файл в метрах веб-меркатора)',
      width_px: rc.w, height_px: rc.h,
      resolution_km: S.layer === 'sat' ? undefined : (S.px * BASE_RES_KM),
      palette: palName,
      missing_tiles: rc.missing ? rc.missing + ' из ' + rc.total + ' тайлов не были загружены на момент экспорта' : undefined,
      attribution: (S.layer === 'sat' ? '© EUMETSAT' : 'rainradar.ru') + (isComposite ? ' · базовая карта © OpenStreetMap, © CARTO' : '')
    };
  }

  /* ─── CSV значений dBZ по видимой области (из raw-данных кэша, лимит ~40 тыс. строк) ─── */
  function exportCSV(baseName, onDone) {
    var tiles = visTiles(), epx = (S.px < 1) ? 1 : S.px;
    /* Подбор шага сетки, чтобы не раздуть файл */
    var est = 0;
    tiles.forEach(function(t) { var e = S.cache.get(CK(t.x, t.y)); if (e && e.raw) { var W = e.canvas.width; est += Math.pow(Math.ceil(W / epx), 2); } });
    var stride = Math.max(1, Math.ceil(Math.sqrt(est / 40000)));
    var rows = [], skippedTiles = 0, idx = 0;
    function procTile() { /* по тайлу за таймслот — UI не замирает */
      var budgetEnd = idx + 3;
      for (; idx < tiles.length && idx < budgetEnd; idx++) {
        var t = tiles[idx], entry = S.cache.get(CK(t.x, t.y));
        if (!entry || !entry.raw) { skippedTiles++; continue; }
        var W = entry.canvas.width, bw = Math.ceil(W / epx);
        var r = tileRect(t.x, t.y);
        if (r.sw <= 0 || r.sh <= 0) continue;
        for (var by = 0; by < bw; by += stride) {
          for (var bx = 0; bx < bw; bx += stride) {
            /* клип к экрану: центр ячейки в контейнерных координатах */
            var fx = (bx + 0.5) * epx / W, fy = (by + 0.5) * epx / W;
            var sx = r.sx + fx * r.sw, sy = r.sy + fy * r.sh;
            if (sx < 0 || sx > innerWidth || sy < 0 || sy > innerHeight) continue;
            var ix = Math.min(W - 1, Math.round((bx + 0.5) * epx)), iy = Math.min(W - 1, Math.round((by + 0.5) * epx));
            var v = entry.raw[iy * W + ix];
            if (!(v >= MDBZ)) continue; /* только ячейки с данными */
            var lat = y2lat(t.y + fy, FZ), lng = x2lon(t.x + fx, FZ);
            rows.push(lat.toFixed(4) + ',' + lng.toFixed(4) + ',' + Math.round(v)); /* сырые dBZ, без преобразований */
          }
        }
      }
      if (idx < tiles.length) { setTimeout(procTile, 0); return; }
      var meta = exportMeta({ w: innerWidth, h: innerHeight, missing: skippedTiles, total: tiles.length });
      var head = '# tatmeteo radar export (dBZ)\n# frame_time_msk: ' + meta.frame_time_msk +
        '\n# layer: ' + meta.layer + ' | zoom: ' + meta.zoom + ' | resolution_km: ' + meta.resolution_km +
        '\n# grid_stride: ' + stride + (skippedTiles ? ' | missing_tiles: ' + skippedTiles : '') +
        '\nlat,lng,dbz\n';
      downloadBlob(new Blob([head + rows.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }), baseName + '.csv');
      onDone();
    }
    procTile();
  }

  /* ─── Ожидание недостающих тайлов перед экспортом (до 6с, шаг 300мс) ─── */
  function waitForTiles(cb) {
    var t0 = Date.now();
    (function check() {
      var missing = 0, tiles = visTiles();
      for (var i = 0; i < tiles.length; i++) if (!S.cache.has(CK(tiles[i].x, tiles[i].y))) missing++;
      if (missing === 0 || Date.now() - t0 > 6000) { cb(missing); return; }
      setTimeout(check, 300);
    })();
  }

  function doExport(fmt) {
    if (S.layer === 'dop' && fmt !== 'map' && fmt !== 'mapgeo') { toast('Для этого слоя доступен экспорт «Карта + слой»'); return; }
    if (fmt === 'csv' && S.layer === 'sat') { toast('CSV доступен только для радара/явлений'); return; }
    if (fmt === 'csv' && radarNcActive()) { toast('CSV с сырыми dBZ доступен в режиме rainradar (переключите источник в легенде)'); return; }
    if (S.layer !== 'sat' && !S.dbzVisible) { toast('Слой скрыт — включите 👁 для экспорта'); return; }
    var btn = $('btn-download');
    btn.classList.add('busy-export');
    var finish = function() { btn.classList.remove('busy-export'); };
    var base = exportBaseName();

    /* ─── Композит «карта + слой»: map — PNG, mapgeo — ZIP с геопривязкой.
       Два пункта, а не один ZIP: быстрый PNG «поделиться» — самый частый сценарий,
       ГИС-пакет нужен реже ─── */
    if (fmt === 'map' || fmt === 'mapgeo') {
      toast('⏳ Собираю композит…');
      var run = function() {
        setTimeout(function() {
          try {
            var rc = renderCompositeToCanvas();
            var du;
            try { du = rc.canvas.toDataURL('image/png'); }
            catch (e) { toast('Композит недоступен: тайлы без CORS (обновите страницу — базовые слои теперь с CORS)'); return; }
            if (fmt === 'map') { downloadBlob(new Blob([dataUrlToU8(du)], { type: 'image/png' }), base + '_map.png'); }
            else {
              var files = [
                { name: base + '_map.png', data: dataUrlToU8(du) },
                { name: base + '_map.pgw', data: new TextEncoder().encode(makeWorldFile(rc.w, rc.h)) },
                { name: base + '_map.json', data: new TextEncoder().encode(JSON.stringify(exportMeta(rc, true), null, 2)) }
              ];
              downloadBlob(makeZip(files), base + '_map.zip');
            }
          } finally { finish(); }
        }, 30);
      };
      if ((S.layer === 'radar' || S.layer === 'wx') && !radarNcActive()) { waitForTiles(function() { run(); }); } else { run(); } /* WMS-слоям канвас-тайлы не нужны */
      return;
    }

    if (S.layer === 'sat') { /* снимок спутника из DOM-тайлов Leaflet */
      setTimeout(function() {
        try {
          var rc = renderSatToCanvas();
          if (!rc) { toast('Спутниковые тайлы ещё не загружены'); return; }
          var du;
          try { du = rc.canvas.toDataURL('image/png'); }
          catch (e) { toast('Экспорт недоступен: прямой сервер без CORS (работает через прокси)'); return; }
          if (fmt === 'png') { downloadBlob(new Blob([dataUrlToU8(du)], { type: 'image/png' }), base + '.png'); }
          else { /* geo: ZIP = PNG + .pgw + JSON */
            var files = [
              { name: base + '.png', data: dataUrlToU8(du) },
              { name: base + '.pgw', data: new TextEncoder().encode(makeWorldFile(rc.w, rc.h)) },
              { name: base + '.json', data: new TextEncoder().encode(JSON.stringify(exportMeta(rc), null, 2)) }
            ];
            downloadBlob(makeZip(files), base + '.zip');
          }
        } finally { finish(); }
      }, 30);
      return;
    }

    if (fmt === 'csv') { exportCSV(base, finish); return; }

    if (radarNcActive()) { /* слой-PNG из WMS-тайлов nowcast */
      setTimeout(function() {
        try {
          var W = Math.round(innerWidth * DPR), H = Math.round(innerHeight * DPR);
          var oc = document.createElement('canvas'); oc.width = W; oc.height = H;
          var octx2 = oc.getContext('2d'); octx2.setTransform(DPR, 0, 0, DPR, 0, 0);
          var drawn = drawTileLayerTo(octx2, radarNcLayer);
          wxNcExtras.forEach(function(l) { drawn += drawTileLayerTo(octx2, l); }); /* станции ОЯ BUFR */
          if (!drawn) { toast('Тайлы 4x4 ещё не загружены'); return; }
          var rcN = { canvas: oc, missing: 0, total: drawn, w: W, h: H };
          var duN = oc.toDataURL('image/png');
          if (fmt === 'png') { downloadBlob(new Blob([dataUrlToU8(duN)], { type: 'image/png' }), base + '.png'); }
          else {
            var filesN = [
              { name: base + '.png', data: dataUrlToU8(duN) },
              { name: base + '.pgw', data: new TextEncoder().encode(makeWorldFile(rcN.w, rcN.h)) },
              { name: base + '.json', data: new TextEncoder().encode(JSON.stringify(exportMeta(rcN), null, 2)) }
            ];
            downloadBlob(makeZip(filesN), base + '.zip');
          }
        } finally { finish(); }
      }, 30);
      return;
    }
    toast('⏳ Подготовка экспорта…');
    waitForTiles(function(missing) {
      setTimeout(function() { /* отпускаем кадр — рендерим вне обработчика клика */
        try {
          var rc = renderRadarToCanvas();
          if (missing) rc.missing = missing;
          var du = rc.canvas.toDataURL('image/png'); /* радар рисуем сами — canvas всегда чистый */
          if (fmt === 'png') { downloadBlob(new Blob([dataUrlToU8(du)], { type: 'image/png' }), base + '.png'); }
          else {
            var files = [
              { name: base + '.png', data: dataUrlToU8(du) },
              { name: base + '.pgw', data: new TextEncoder().encode(makeWorldFile(rc.w, rc.h)) },
              { name: base + '.json', data: new TextEncoder().encode(JSON.stringify(exportMeta(rc), null, 2)) }
            ];
            downloadBlob(makeZip(files), base + '.zip');
          }
        } finally { finish(); }
      }, 30);
    });
  }

  /* Дропдаун экспорта: позиционируем fixed от кнопки — не обрезается скроллом #ctrl-scroll */
  (function initDownloadUI() {
    var btn = $('btn-download'), dd = $('download-dropdown');
    if (!btn || !dd) return;
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (dd.classList.contains('visible')) { dd.classList.remove('visible'); return; }
      var r = btn.getBoundingClientRect();
      var left = Math.min(r.left, innerWidth - 230 - 8); /* не уходить за правый край */
      dd.style.left = Math.max(8, left) + 'px';
      dd.style.top = (r.bottom + 8) + 'px';
      dd.classList.add('visible');
    });
    dd.querySelectorAll('.dd-item').forEach(function(item) {
      var go = function() { dd.classList.remove('visible'); doExport(item.dataset.fmt); };
      item.addEventListener('click', go);
      item.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); btn.focus(); } });
    });
    document.addEventListener('click', function(e) { if (!$('download-wrapper').contains(e.target)) dd.classList.remove('visible'); });
  })();

  /* ─── БЛОК E: сохранение и восстановление вида карты и параметров (ключ mapView) ─── */
  function saveView() {
    try {
      var c = map.getCenter();
      localStorage.setItem('mapView', JSON.stringify({
        center: [+c.lat.toFixed(4), +c.lng.toFixed(4)],
        zoom: map.getZoom(),
        layer: (S.layer === 'sat' && satProduct === 'height') ? 'height' : S.layer,
        satChannel: SAT_CHANNELS[satChIdx].id, /* единый источник — дублирует satChannel-ключ */
        pxIndex: S.pxIndex,
        smooth: S.smooth,
        smoothStrength: S.smoothStrength,
        opacity: S.layer === 'sat' ? radarOpacityMem : (parseInt($('opacity-slider').value) || 100), /* прозрачность радара */
        satOpacity: satOpacityMem, /* прозрачность спутника — отдельно */
        theme: currentTheme, /* 'dark' | 'light' | 'scheme' */
        legendCollapsed: $('legend').classList.contains('collapsed'),
        dbzVisible: S.dbzVisible,
        ltgVisible: ltg.on /* оверлей молний */
      }));
    } catch (e) {}
  }
  var saveViewTmr = null;
  /* Дебаунс 150мс: быстрые свайпы/зумы успевают сохраниться до ухода со страницы */
  function saveViewDebounced() { clearTimeout(saveViewTmr); saveViewTmr = setTimeout(saveView, 150); }
  map.on('moveend zoomend', saveViewDebounced);
  map.on('zoom', saveViewDebounced); /* pinch/double-tap зум фиксируется ещё в процессе */
  /* ГЛАВНЫЙ фикс для мобильных: вкладка сворачивается/закрывается до дебаунса —
     сохраняем немедленно. pagehide надёжнее beforeunload на iOS/Android. */
  window.addEventListener('pagehide', saveView);
  document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'hidden') saveView(); });
  window.addEventListener('beforeunload', saveView); /* не блокирующий, просто сейв */

  /* ─── Индикатор зума поверх слоя данных (#zoom-indicator): z-index 900 —
     выше канваса радара (350) и pane'ов Leaflet, ниже панелей (1000) ─── */
  function updZoomChip(bump) {
    var el = $('zoom-indicator'); if (!el) return;
    var txt = 'Z' + map.getZoom();
    if (el.textContent !== txt) {
      el.textContent = txt;
      if (bump && !REDUCE_MOTION) retrig(el, 'bump');
    }
  }
  map.on('zoom', function() { updZoomChip(false); });      /* живое обновление при pinch */
  map.on('zoomend', function() { updZoomChip(true); });    /* «bump» только по факту смены */

  /* Восстановление ДО первой тяжёлой отрисовки; время кадра не восстанавливаем — всегда LIVE */
  function restoreView() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem('mapView') || 'null'); } catch (e) {}
    if (!v || typeof v !== 'object') return;
    try {
      /* Валидация: зум [3..10], координаты — конечные числа; иначе дефолт [57,55] z6 */
      if (Array.isArray(v.center) && isFinite(v.center[0]) && isFinite(v.center[1]) && isFinite(v.zoom)) {
        var z = Math.max(3, Math.min(10, Math.round(v.zoom)));
        var la = Math.max(-85, Math.min(85, +v.center[0]));
        var lo = Math.max(-180, Math.min(180, +v.center[1]));
        map.setView([la, lo], z, { animate: false });
      }
      /* Тема: три режима; старые значения 'light'/'dark' работают, битые → 'dark' */
      if (typeof v.theme === 'string') applyTheme(v.theme, false);
      if (typeof v.pxIndex === 'number' && v.pxIndex >= 0 && v.pxIndex < S.pxLevels.length) {
        S.pxIndex = v.pxIndex | 0; S.px = S.pxLevels[S.pxIndex]; updatePxLabel();
      }
      if (typeof v.smoothStrength === 'number') {
        S.smoothStrength = Math.max(0, Math.min(4, v.smoothStrength | 0));
        $('smooth-strength').value = S.smoothStrength; $('smooth-val').textContent = S.smoothStrength;
      }
      if (v.smooth) { S.smooth = true; $('btn-smooth').classList.add('on'); $('smooth-control').classList.add('active'); }
      if (typeof v.opacity === 'number') {
        var op = Math.max(0, Math.min(100, v.opacity | 0));
        $('opacity-slider').value = op; $('opacity-val').textContent = op + '%'; canvas.style.opacity = op / 100;
      }
      if (v.legendCollapsed) { $('legend').classList.add('collapsed'); $('toggle-legend-btn').innerHTML = '+'; S.legendVis = false; }
      if (typeof v.satOpacity === 'number') satOpacityMem = Math.max(0, Math.min(100, v.satOpacity | 0));
      if (typeof v.satChannel === 'string') {
        var fi = -1;
        for (var i = 0; i < SAT_CHANNELS.length; i++) if (SAT_CHANNELS[i].id === v.satChannel) { fi = i; break; }
        if (fi >= 0 && fi !== satChIdx) {
          satChIdx = fi;
          $('btn-channel').textContent = 'Канал: ' + SAT_CHANNELS[fi].label;
          document.querySelectorAll('#channel-dropdown .dd-item').forEach(function(it, j) { it.classList.toggle('active', j === fi); });
        }
      }
      if (v.layer === 'sat' || v.layer === 'wx' || v.layer === 'dop' || v.layer === 'height') setLayer(v.layer); /* WMS-слои пересоздаются с актуальным кадром */
      if (v.ltgVisible) setLtg(true, true); /* тихо, без тостов при старте */
      if (v.dbzVisible === false && S.layer !== 'sat') {
        S.dbzVisible = false; canvas.style.display = 'none'; applyDbzUI();
      }
    } catch (e) { /* битые данные — остаёмся на дефолте */ }
  }

  try { localStorage.removeItem('calibration'); } catch (e) {} /* калибровка удалена — чистим старый ключ */
  applyAnimPref(); updateAnimBtn();
  loadPalettesFromStorage(); applyTheme('dark', false); restoreView(); buildLegend(); buildFrames(); updHUD(); updatePxLabel(); applyDbzUI(); schedRender();
  /* Радар — дефолтный слой: в режиме nowcast WMS-слой создаём сразу (канвас скрыт).
     Отдельный прогрев (как у спутника) не нужен: радар и есть стартовый слой,
     его LIVE-кадр попадает в LRU-кэш SatWMS при первом же показе. */
  if (radarNcActive()) { canvas.style.display = 'none'; radarNcApply(true); }
  /* После restoreView (и при первом заходе без сохранений): актуальный зум в чипе
     и повторный invalidateSize — на мобильных вьюпорт меняется из-за URL-бара */
  updZoomChip(false);
  setTimeout(function() { map.invalidateSize(); updZoomChip(false); }, 100);
  window.addEventListener('load', function() { setTimeout(function() { map.invalidateSize(); }, 200); });

  $('playbtn').addEventListener('click', togglePlay);
  $('spd').addEventListener('click', cycleSpeed);
  $('pxbtn').addEventListener('click', cyclePx);
  $('btn-smooth').addEventListener('click', toggleSmooth);
  $('btn-refresh').addEventListener('click', doRefresh);
  /* Переключатель анимаций: «Авто» уважает систему (a11y по умолчанию),
     «Вкл» — осознанный выбор пользователя видеть анимации даже при системном reduce */
  function animLabel() { return ANIM_PREF === 'auto' ? 'Авто' : (ANIM_PREF === 'on' ? 'Вкл' : 'Выкл'); }
  function updateAnimBtn() { var b = $('btn-anim'); if (b) { b.textContent = 'Анимации: ' + animLabel(); b.classList.toggle('on', ANIM_PREF === 'on'); } }
  if ($('btn-anim')) $('btn-anim').addEventListener('click', function() {
    ANIM_PREF = ANIM_PREF === 'auto' ? 'on' : (ANIM_PREF === 'on' ? 'off' : 'auto');
    try { localStorage.setItem('animPref', ANIM_PREF); } catch (e) {}
    applyAnimPref(); updateAnimBtn();
    toast('Анимации: ' + animLabel() + (ANIM_PREF === 'auto' ? ' (по системе)' : ''));
  });
  /* Статус-чип кликабелен: на ПК — принудительное обновление, на мобильном сначала
     показываем полный текст (чип обрезан ellipsis'ом), т.к. title по тапу недоступен */
  $('dbg').addEventListener('click', function() {
    if (IS_MOBILE) { toast(this.textContent || ''); } else { doRefresh(); }
  });
  if ($('btn-toggle-dbz')) $('btn-toggle-dbz').addEventListener('click', toggleDbz);
  $('btn-crosshair').addEventListener('click', toggleCrosshair);
  $('btn-ruler').addEventListener('click', toggleRuler);
  $('b-minus1h').addEventListener('click', function() { retrig(this, 'bump'); shiftTs(-3600); });
  $('b-minus10m').addEventListener('click', function() { retrig(this, 'bump'); shiftTs(-600); });
  $('b-plus10m').addEventListener('click', function() { retrig(this, 'bump'); shiftTs(600); });
  $('toggle-legend-btn').addEventListener('click', function(e) { e.stopPropagation(); toggleLegend(); });
  $('legend-header').addEventListener('click', toggleLegend);

  $('btn-layers-menu').addEventListener('click', function(e) { e.stopPropagation(); $('layers-dropdown').classList.toggle('visible'); });
  document.querySelectorAll('#layers-dropdown .dd-item').forEach(function(item) {
    item.addEventListener('click', function() { setLayer(this.dataset.layer); $('layers-dropdown').classList.remove('visible'); });
    /* Клавиатура: Enter/Space выбирают слой */
    item.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLayer(this.dataset.layer); $('layers-dropdown').classList.remove('visible'); $('btn-layers-menu').focus(); } });
  });
  document.addEventListener('click', function(e) { if (!$('layers-wrapper').contains(e.target)) { $('layers-dropdown').classList.remove('visible'); } });

  var smoothSlider = $('smooth-strength');
  var smoothValEl = $('smooth-val');
  smoothSlider.addEventListener('input', function() { S.smoothStrength = parseInt(this.value); smoothValEl.textContent = S.smoothStrength; retrig(smoothValEl, 'bump'); if (S.smooth) { S.cache.clear(); S.pending.clear(); S.failed.clear(); forceRefresh(); toast('Сила сглаживания: ' + S.smoothStrength); } saveViewDebounced(); });

  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { if (crosshairMode) { toggleCrosshair(); return; } if (S.ruler.active) { toggleRuler(); return; } if (helpModal && helpModal.classList.contains('open')) { closeHelp(); return; } if (modal.classList.contains('open')) { closeModal(); return; } } });
  map.on('zoomstart', function() { if (crosshairMode) hoverEl.style.display = 'none'; });
  map.on('move moveend zoomend', function() { if (crosshairMode) updateCrosshair(); });
  window.addEventListener('resize', function() { if (crosshairMode) updateCrosshair(); });

  window.closeModal = closeModal; window.openModal = openModal; window.setLayer = setLayer;
  console.log('Tatmeteo загружен. 1x1 км интерполяция, EUMETSAT WMS и обновленные палитры активны.');
})();
