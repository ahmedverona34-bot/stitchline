/* Stitchline: Arabic interface. Loaded before app.js.
   The app writes its interface in English; this file translates every text node and tooltip as it appears
   (exact phrases first, then patterns for text that contains names or numbers) and sets right-to-left layout. */
(() => {
  'use strict';
  let lang = 'ar';
  try { lang = localStorage.getItem('stl.lang') || 'ar'; } catch {}
  lang = lang.replace(/"/g, '');
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';

  const AR = {
    // ---------------------------------------------------------------- window, stages, top bar
    'Stitchline': 'ستيتشلاين',
    'Import': 'استيراد', 'Arrange': 'ترتيب', 'Stitch': 'الغرز', 'Sequence': 'التسلسل', 'Output': 'الإخراج',
    'Workflow': 'مراحل العمل', 'Inspector': 'لوحة الخصائص', 'mm': 'مم', 'Find any tool': 'ابحث عن أي أداة', 'Ctrl K': 'Ctrl K',
    'Open (Ctrl+O)': 'فتح (Ctrl+O)', 'Open': 'فتح', 'Save job (Ctrl+S)': 'حفظ الشغلانة (Ctrl+S)', 'Save': 'حفظ',
    'Undo (Ctrl+Z)': 'تراجع (Ctrl+Z)', 'Undo': 'تراجع', 'Redo (Ctrl+Y)': 'إعادة (Ctrl+Y)', 'Redo': 'إعادة',
    'Light / dark': 'فاتح / داكن', 'Switch light or dark': 'التبديل بين الفاتح والداكن', 'Rename job': 'تغيير اسم الشغلانة',
    'Language': 'اللغة', 'English': 'English',
    // ---------------------------------------------------------------- layers panel
    'Layers': 'الطبقات', 'Layers and shapes': 'الطبقات والأشكال', 'Layer': 'طبقة',
    'Make a layer from the selection (Ctrl+G)': 'اعمل طبقة من المحدد (Ctrl+G)', 'Make a layer from the selection': 'اعمل طبقة من المحدد',
    'Make a layer': 'عمل طبقة', 'Make layer': 'عمل الطبقة', 'New empty layer': 'طبقة جديدة فاضية', 'Add shape': 'إضافة شكل',
    'Insert file': 'إدراج ملف', 'All': 'الكل', 'Select all (Ctrl+A)': 'تحديد الكل (Ctrl+A)',
    'Show shapes': 'إظهار الأشكال', 'Layer colour': 'لون الطبقة', 'Double-click to rename': 'دبل كليك لتغيير الاسم',
    'Needle (click to change)': 'الإبرة (اضغط للتغيير)', 'Sew this layer': 'خياطة هذه الطبقة', 'Laser': 'ليزر',
    'Select all shapes in this layer': 'تحديد كل أشكال الطبقة', 'Rename…': 'تغيير الاسم…',
    'Make this a laser cut layer': 'اجعلها طبقة قص ليزر', 'Make this a sewing layer': 'اجعلها طبقة خياطة',
    'Use these stitch settings for every layer': 'استخدم إعدادات الغرز دي لكل الطبقات',
    'Move layer up': 'تحريك الطبقة لفوق', 'Move layer down': 'تحريك الطبقة لتحت',
    'Delete layer, keep its shapes': 'حذف الطبقة مع الاحتفاظ بأشكالها', 'Delete layer and its shapes': 'حذف الطبقة وأشكالها',
    'Delete layer?': 'حذف الطبقة؟', 'No layers yet. Open a drawing or add a shape.': 'لا توجد طبقات بعد. افتح رسمة أو أضف شكلاً.',
    'New layer': 'طبقة جديدة', 'New layer…': 'طبقة جديدة…', 'Name of the new layer': 'اسم الطبقة الجديدة', 'Name of the new empty layer': 'اسم الطبقة الجديدة الفاضية',
    // ---------------------------------------------------------------- canvas, dock, readout
    'Drawing canvas': 'لوحة الرسم', 'Canvas tools': 'أدوات اللوحة', 'Select and move (V)': 'تحديد وتحريك (V)',
    'Selection: move and resize whole shapes (V)': 'التحديد: تحريك الأشكال كاملة وتغيير مقاسها (V)', 'Selection': 'التحديد',
    'Direct selection: move one path (A)': 'التحديد المباشر: تحريك مسار واحد (A)', 'Direct selection': 'التحديد المباشر',
    'Selection: move and resize whole shapes': 'التحديد: تحريك الأشكال كاملة وتغيير مقاسها', 'Direct selection: move one path': 'التحديد المباشر: تحريك مسار واحد',
    'Resize keeping proportions': 'تغيير المقاس مع الحفاظ على النسب', 'Resize from the centre': 'تغيير المقاس من المنتصف',
    'The size must be more than 0.': 'المقاس لازم يكون أكبر من 0.',
    'Pan (H, or hold Space)': 'تحريك العرض (H أو اضغط Space)', 'Set start point (S)': 'تحديد نقطة البداية (S)', 'Start': 'البداية',
    'Measure (M)': 'قياس (M)', 'Zoom out (−)': 'تصغير (−)', 'Zoom out': 'تصغير', 'Zoom in (+)': 'تكبير (+)', 'Zoom in': 'تكبير',
    'Fit (F)': 'ملاءمة (F)', 'Fit': 'ملاءمة', 'Show': 'عرض', 'Show all layers': 'عرض كل الطبقات', 'Show only the current layer': 'عرض الطبقة الحالية فقط',
    'Show sewing order (O)': 'عرض ترتيب الخياطة (O)', 'Order': 'الترتيب', 'Show stitches (T)': 'عرض الغرز (T)', 'Stitches': 'الغرز',
    'Play': 'تشغيل', 'Position in the sewing run': 'الموضع في الخياطة', 'Speed': 'السرعة', 'Close simulation': 'إغلاق المحاكاة',
    'Needle': 'إبرة', 'Fit drawing': 'ملاءمة الرسمة', 'Add a shape here…': 'إضافة شكل هنا…', 'Select all': 'تحديد الكل',
    'Start sewing here': 'ابدأ الخياطة من هنا', 'Reverse direction': 'عكس الاتجاه', 'Duplicate': 'نسخ', 'Mirror left–right': 'عكس يمين–شمال',
    'Mirror up–down': 'عكس فوق–تحت', 'Split at the nearest point': 'تقسيم عند أقرب نقطة', 'Edit points…': 'تعديل النقاط…',
    'Sections (zigzag, back-tack)…': 'أجزاء (زجزاج، رجوع)…', 'Delete': 'حذف',
    // ---------------------------------------------------------------- empty state
    'Start a sewing job': 'ابدأ شغلانة خياطة', 'Open a pattern drawing, or drop the file anywhere in this window.': 'افتح رسمة الباترون، أو اسحب الملف وأفلته في أي مكان في الشباك.',
    'Open drawing…': 'فتح رسمة…', 'Draw a shape': 'ارسم شكلاً', 'Recent': 'الأخيرة', 'Drop to open': 'أفلت للفتح',
    // ---------------------------------------------------------------- import
    'Bring in a drawing and set how it is read.': 'أدخل رسمة وحدد طريقة قراءتها.', 'Drop a drawing anywhere in the window, or': 'أفلت رسمة في أي مكان في الشباك، أو',
    'Open file…': 'فتح ملف…', 'Insert into job…': 'إدراج في الشغلانة…', 'Recent files': 'الملفات الأخيرة',
    'When opening a file': 'عند فتح ملف', 'clean-up': 'تنظيف', 'Remove overlapping shapes': 'حذف الأشكال المتداخلة',
    "Don't join lines automatically": 'لا تربط الخطوط تلقائياً', 'Work without a reference point': 'العمل بدون نقطة مرجعية',
    'Resolution': 'الدقة', 'Custom': 'مخصص', 'Used for PLT and PRT files. Open the file again after changing it.': 'تُستخدم لملفات PLT و PRT. افتح الملف مرة أخرى بعد تغييرها.',
    'Scale drawing': 'تكبير/تصغير الرسمة', 'Horizontal (X)': 'أفقي (X)', 'Vertical (Y)': 'رأسي (Y)', 'Apply when opening a file': 'تطبيق عند فتح ملف',
    'Scale drawing now': 'تطبيق المقياس الآن', 'From a measurement…': 'من قياس…', 'Display': 'العرض', 'fast': 'سريع', 'glass': 'زجاجي',
    'Glass effects (needs a faster computer)': 'تأثيرات زجاجية (تحتاج جهاز أسرع)', 'Off keeps Stitchline quick on older computers.': 'إيقافها يُبقي البرنامج سريعاً على الأجهزة القديمة.',
    'Machine table': 'طاولة الماكينة', 'Width': 'العرض', 'Height': 'الارتفاع', 'Continue to Arrange': 'متابعة إلى الترتيب',
    // ---------------------------------------------------------------- arrange
    'Click a shape on the drawing or in Layers. Hold': 'اضغط على شكل في الرسمة أو في الطبقات. اضغط', 'to pick several, or drag a box around them.': 'لاختيار أكثر من شكل، أو اسحب مربعاً حولها.',
    'Whole drawing': 'الرسمة كلها', 'all shapes': 'كل الأشكال', 'Add a shape…': 'إضافة شكل…', 'Remove overlaps': 'حذف التداخلات',
    'Join lines < 2 mm': 'ربط الخطوط < 2 مم', 'Continue to Stitch': 'متابعة إلى الغرز', 'Move': 'تحريك', 'nudge': 'تحريك بسيط',
    'Up': 'لفوق', 'Down': 'لتحت', 'Left': 'شمال', 'Right': 'يمين', 'Move to origin': 'نقل إلى نقطة الأصل', 'Move to the origin (0, 0)': 'نقل إلى نقطة الأصل (0، 0)',
    'Step': 'الخطوة', 'Rotate, mirror & size': 'تدوير وعكس وحجم', 'Rotate': 'تدوير', 'Resize': 'تغيير الحجم',
    'Shape path': 'مسار الشكل', 'start · direction · ends': 'البداية · الاتجاه · الأطراف', 'Pick start point': 'اختيار نقطة البداية',
    'Start every shape at the': 'ابدأ كل شكل من', 'Top': 'فوق', 'Bottom': 'تحت',
    'Extend start (+) / shorten (−)': 'إطالة البداية (+) / تقصير (−)', 'Extend end (+) / shorten (−)': 'إطالة النهاية (+) / تقصير (−)',
    'Apply to ends': 'تطبيق على الأطراف', 'Edit points one by one…': 'تعديل النقاط واحدة واحدة…', 'Organize': 'تنظيم', 'Name': 'الاسم',
    'Duplicate…': 'نسخ…', 'Reference point…': 'نقطة مرجعية…', 'Sections (zigzag…)': 'أجزاء (زجزاج…)', 'Clean up': 'تنظيف',
    'Merge close points': 'دمج النقاط القريبة', 'Delete shorter lines': 'حذف الخطوط الأقصر', 'Join line ends': 'ربط أطراف الخطوط',
    'Remove overlapping copies': 'حذف النسخ المتداخلة',
    // ---------------------------------------------------------------- stitch
    'Settings apply to every shape in the layer.': 'الإعدادات تُطبق على كل أشكال الطبقة.', 'This layer is': 'هذه الطبقة', 'Sewing': 'خياطة', 'Laser cut': 'قص ليزر',
    'Laser cut: needle 3 switches the laser on (output IO 5) and the cut follows each line once, with no stitches, back-tack or overlap.':
      'قص ليزر: الإبرة 3 تشغّل الليزر (مخرج IO 5) والقص يمشي على كل خط مرة واحدة، بدون غرز أو رجوع أو تداخل.',
    'Stitch length': 'طول الغرزة', 'Convert lines to stitches': 'تحويل الخطوط إلى غرز',
    'Off: the machine sews along each line with its own stitch length.': 'مقفول: الماكينة تخيط على كل خط بطول الغرزة الخاص بها.',
    'Sewing head': 'رأس الخياطة', 'Back-tack (open lines)': 'الرجوع (الخطوط المفتوحة)', 'Start stitches': 'غرز البداية', 'Start repeats': 'تكرار البداية',
    'End stitches': 'غرز النهاية', 'End repeats': 'تكرار النهاية', 'Closed shapes': 'الأشكال المغلقة', 'Start reinforcement': 'تقوية البداية',
    'Repeats': 'التكرار', 'Overlap past the start': 'التداخل بعد البداية', 'End repeat stitches': 'غرز تكرار النهاية', 'Corners': 'الزوايا',
    'Corner angle': 'زاوية الركن', 'Slow down at corners': 'تبطيء عند الزوايا', 'Slow stitches': 'غرز التبطيء',
    'Dense stitches at corners': 'غرز كثيفة عند الزوايا', 'Dense stitch count': 'عدد الغرز الكثيفة', 'Density factor': 'معامل الكثافة',
    'Dense start & end': 'كثافة البداية والنهاية', 'Dense stitches at start / end': 'غرز كثيفة في البداية / النهاية',
    'Special & double length': 'طول خاص ومزدوج', 'Special stitch length': 'طول الغرزة الخاص',
    'For sections marked “special”. 0 keeps the drawn points.': 'للأجزاء المعلّمة "خاص". 0 يحتفظ بالنقاط المرسومة.',
    'Special speed': 'السرعة الخاصة', 'Separate speed for special parts': 'سرعة منفصلة للأجزاء الخاصة', 'Use double stitch length': 'استخدام طول غرزة مزدوج',
    'Double length': 'الطول المزدوج', 'Odd stitches': 'الغرز الفردية', 'Even': 'الزوجية', 'Machine': 'الماكينة',
    'Machine origin (corner of the drawing)': 'نقطة أصل الماكينة (ركن الرسمة)', 'Top left': 'فوق شمال', 'Top right': 'فوق يمين',
    'Bottom left': 'تحت شمال', 'Bottom right': 'تحت يمين', 'Small closed shapes become one point': 'الأشكال المغلقة الصغيرة تتحول لنقطة',
    '…when smaller than': '…لو أصغر من', 'Backlash compensation': 'تعويض الخلوص', 'X− / X+': 'X− / X+', 'Y− / Y+': 'Y− / Y+',
    'stitch': 'غرزة', 'back-tack': 'رجوع', 'dense': 'كثيف', 'slow': 'بطيء', 'zigzag': 'زجزاج', 'special': 'خاص',
    'Use these settings for every layer': 'استخدم الإعدادات دي لكل الطبقات', 'Continue to Sequence': 'متابعة إلى التسلسل',
    'origin bottom-left': 'الأصل تحت شمال', 'origin bottom-right': 'الأصل تحت يمين', 'origin top-left': 'الأصل فوق شمال', 'origin top-right': 'الأصل فوق يمين', 'off': 'مقفول',
    // ---------------------------------------------------------------- sequence
    'Sewing order': 'ترتيب الخياطة', 'Drag to reorder. The numbers on the drawing follow this list.': 'اسحب لتغيير الترتيب. الأرقام على الرسمة تتبع هذه القائمة.',
    'Sort automatically': 'ترتيب تلقائي', 'rows': 'صفوف', 'Layer by layer (follow the layer list)': 'طبقة بطبقة (حسب ترتيب الطبقات)',
    'Sews each layer completely before the next one, e.g. all sewing first and the laser cut layer last. Move a layer up or down by right-clicking it.':
      'يخلّص كل طبقة بالكامل قبل اللي بعدها، مثلاً الخياطة كلها الأول وطبقة القص بالليزر في الآخر. حرّك الطبقة لفوق أو لتحت بكليك يمين عليها.',
    'Top → bottom': 'فوق ← تحت', 'Bottom → top': 'تحت ← فوق', 'Left → right': 'شمال ← يمين', 'Right → left': 'يمين ← شمال',
    'Shortest travel (nearest next)': 'أقصر مسافة انتقال (الأقرب أولاً)', 'Sort by end point': 'ترتيب حسب نقطة النهاية', 'Row spacing': 'المسافة بين الصفوف',
    'Travel moves': 'حركات الانتقال', 'Corner instructions on travel moves': 'أوامر الزوايا في حركات الانتقال', 'Simulate sewing': 'محاكاة الخياطة',
    'Continue to Output': 'متابعة إلى الإخراج',
    // ---------------------------------------------------------------- output
    'Output to machine': 'الإخراج للماكينة', 'Check the program, then save it for the machine.': 'راجع البرنامج، ثم احفظه للماكينة.',
    'Needle positions': 'نقاط الإبرة', 'Sewing length': 'طول الخياطة', 'Shapes sewn': 'الأشكال المخيطة', 'Estimated time': 'الوقت المتوقع',
    'Program': 'البرنامج', 'Insert': 'إدراج', 'Move up': 'لفوق', 'Move down': 'لتحت',
    'Automatic instructions': 'أوامر تلقائية', 'job, layer, shape': 'الشغلانة، الطبقة، الشكل', 'Default instructions…': 'الأوامر الافتراضية…',
    'Sewing speed': 'سرعة الخياطة', 'Gradual speed start': 'بدء تدريجي للسرعة', 'Start speed': 'سرعة البداية',
    'Output IO at positions…': 'مخرج IO عند مواضع…', 'IO on reverse…': 'IO أثناء الرجوع…', 'Machine file': 'ملف الماكينة',
    'Scale output': 'تكبير/تصغير الإخراج', 'Scale X / Y': 'المقياس X / Y',
    'Coordinates are measured from the machine origin set in Stitch → Machine.': 'الإحداثيات تُقاس من نقطة أصل الماكينة المحددة في الغرز ← الماكينة.',
    'Other formats': 'صيغ أخرى', 'DXF contents': 'محتوى DXF', 'Lines': 'خطوط', 'DXF…': 'DXF…', 'Picture…': 'صورة…', 'Stitch list…': 'قائمة الغرز…',
    'Save job (.stitchline)…': 'حفظ الشغلانة (.stitchline)…', 'Save machine file…': 'حفظ ملف الماكينة…',
    'Plug in a USB drive to save straight onto it.': 'وصّل فلاشة USB للحفظ عليها مباشرة.', 'Save to USB drive': 'حفظ على فلاشة USB',
    'travel': 'انتقال', 'head': 'الرأس', 'layer': 'طبقة', 'job only': 'في الشغلانة فقط', 'added': 'مضاف',
    'job start': 'بداية الشغلانة', 'job end': 'نهاية الشغلانة', 'layer start': 'بداية الطبقة', 'layer end': 'نهاية الطبقة',
    'shape start': 'بداية الشكل', 'shape end': 'نهاية الشكل', 'sewing start': 'بداية الخياطة', 'sewing end': 'نهاية الخياطة',
    'head 3 start': 'بداية الرأس 3', 'head 3 end': 'نهاية الرأس 3', 'head 3 shape start': 'بداية شكل الرأس 3', 'head 3 shape end': 'نهاية شكل الرأس 3',
    'head 2 start': 'بداية الرأس 2', 'head 2 end': 'نهاية الرأس 2', 'head 2 shape start': 'بداية شكل الرأس 2', 'head 2 shape end': 'نهاية شكل الرأس 2',
    'stitch shape start': 'بداية شكل الغرز', 'stitch shape end': 'نهاية شكل الغرز', 'before sewing end': 'قبل نهاية الخياطة', 'at corners': 'عند الزوايا',
    'align': 'محاذاة', 'Reference point 1': 'النقطة المرجعية 1', 'Reference point 2': 'النقطة المرجعية 2',
    // instruction names
    'Delay': 'انتظار', 'Output IO': 'مخرج IO', 'Input IO': 'مدخل IO', 'Z axis': 'محور Z', 'U axis': 'محور U', 'Label': 'علامة', 'Loop': 'تكرار',
    'Main shaft position': 'موضع العمود الرئيسي', 'Thread trim': 'قص الخيط', 'Presser foot up': 'رفع الدواسة', 'Presser foot down': 'إنزال الدواسة',
    'XY offset move': 'إزاحة XY', 'Back to origin': 'رجوع لنقطة الأصل', 'Pause': 'إيقاف مؤقت', 'Needle change': 'تغيير الإبرة',
    // events
    'Job start': 'بداية الشغلانة', 'Job end': 'نهاية الشغلانة', 'Sewing start': 'بداية الخياطة', 'Sewing end': 'نهاية الخياطة',
    'Layer start': 'بداية الطبقة', 'Layer end': 'نهاية الطبقة', 'Shape start': 'بداية الشكل', 'Shape end': 'نهاية الشكل',
    'At corners': 'عند الزوايا', 'Before sewing end': 'قبل نهاية الخياطة', 'Head 2 start': 'بداية الرأس 2', 'Head 2 end': 'نهاية الرأس 2',
    'Head 3 start': 'بداية الرأس 3', 'Head 3 end': 'نهاية الرأس 3', 'Head 2 shape start': 'بداية شكل الرأس 2', 'Head 2 shape end': 'نهاية شكل الرأس 2',
    'Head 3 shape start': 'بداية شكل الرأس 3', 'Head 3 shape end': 'نهاية شكل الرأس 3', 'Stitch shape start': 'بداية شكل الغرز', 'Stitch shape end': 'نهاية شكل الغرز',
    // ---------------------------------------------------------------- sheets
    // ---------------------------------------------------------------- new design: hints, shortcuts sheet
    'Import (1)': 'استيراد (1)', 'Arrange (2)': 'ترتيب (2)', 'Stitch (3)': 'الغرز (3)', 'Sequence (4)': 'التسلسل (4)', 'Output (5)': 'الإخراج (5)',
    'Find any tool (Ctrl+K)': 'ابحث عن أي أداة (Ctrl+K)', 'Keyboard shortcuts (?)': 'اختصارات الكيبورد (?)', 'Keyboard shortcuts': 'اختصارات الكيبورد',
    'Light / dark (Ctrl+Shift+L)': 'فاتح / داكن (Ctrl+Shift+L)', 'Save machine file (Ctrl+E)': 'حفظ ملف الماكينة (Ctrl+E)', 'Save machine file': 'حفظ ملف الماكينة',
    'Insert file (Ctrl+I)': 'إدراج ملف (Ctrl+I)', 'Layers shown': 'الطبقات المعروضة', 'Zoom': 'التكبير', 'Switch': 'تبديل',
    'Point at any button to see its shortcut.': 'وقّف الماوس على أي زرار يظهرلك اختصاره.',
    'File': 'ملف', 'Edit': 'تعديل', 'View and tools': 'عرض وأدوات', 'Stages': 'المراحل', 'new': 'جديد',
    'Open a drawing or job': 'فتح رسمة أو شغلانة', 'Insert a drawing': 'إدراج رسمة', 'Clear the selection': 'إلغاء التحديد',
    'Nudge the selection': 'تحريك المحدد شوية', 'Nudge ×10': 'تحريك ×10', 'Delete layer, keep its shapes': 'حذف الطبقة مع الاحتفاظ بأشكالها',
    'Make a layer from the selection': 'اعمل طبقة من المحدد', 'Delete selected': 'حذف المحدد',
    'Select and move': 'تحديد وتحريك', 'Pan': 'تحريك العرض', 'Pan while held': 'تحريك العرض وهو مضغوط', 'Set start point': 'تحديد نقطة البداية',
    'Measure': 'قياس', 'Fit the drawing': 'الرسمة كلها في الشاشة', 'Zoom in / out': 'تكبير / تصغير', 'Show stitches': 'عرض الغرز',
    'Show sewing order': 'عرض ترتيب الخياطة',
    'Cancel': 'إلغاء', 'Done': 'تم', 'OK': 'موافق', 'Close': 'إغلاق', 'Apply': 'تطبيق', 'Add': 'إضافة', 'Remove': 'حذف', 'Reset': 'إعادة ضبط',
    'Places a new shape at an exact position (mm).': 'يضع شكلاً جديداً في موضع محدد (مم).', 'Point': 'نقطة', 'Line': 'خط', 'Rectangle': 'مستطيل', 'Circle': 'دائرة',
    'Position X': 'الموضع X', 'Position Y': 'الموضع Y', 'Length / width / radius': 'الطول / العرض / نصف القطر', 'Height (rectangle)': 'الارتفاع (مستطيل)',
    'Copies the selected shapes.': 'ينسخ الأشكال المحددة.', 'Offset X': 'إزاحة X', 'Offset Y': 'إزاحة Y',
    'Mirror the copy left–right': 'عكس النسخة يمين–شمال', 'Mirror the copy up–down': 'عكس النسخة فوق–تحت', 'Number of copies': 'عدد النسخ',
    'Reference points': 'النقاط المرجعية', 'Use the start of the selected shape to line the job up on the machine.': 'استخدم بداية الشكل المحدد لمحاذاة الشغلانة على الماكينة.',
    'Remove all': 'حذف الكل', 'Scale from a measurement': 'المقياس من قياس', 'Sew a test piece, measure a known distance, and enter both values.': 'خيّط قطعة تجربة، قِس مسافة معروفة، وأدخل القيمتين.',
    'Length in the drawing': 'الطول في الرسمة', 'Measured on the fabric': 'المقاس على القماش', 'Apply to': 'تطبيق على', 'X and Y': 'X و Y', 'X only': 'X فقط', 'Y only': 'Y فقط',
    'Use this scale': 'استخدم هذا المقياس', 'Edit points': 'تعديل النقاط', 'Closed shape': 'شكل مغلق', 'Add point': 'إضافة نقطة', 'Delete point': 'حذف النقطة',
    'X (mm)': 'X (مم)', 'Y (mm)': 'Y (مم)', 'Sections': 'الأجزاء', 'Zigzag': 'زجزاج', 'Back-tack': 'رجوع', 'Special length': 'طول خاص', 'From': 'من', 'To': 'إلى',
    'Zigzag width': 'عرض الزجزاج', 'Zigzag step': 'خطوة الزجزاج', 'Zigzag shape': 'شكل الزجزاج', 'Start position': 'موضع البداية', 'Middle': 'المنتصف',
    'Clear sections': 'مسح الأجزاء', 'Add section': 'إضافة جزء', 'Default instructions': 'الأوامر الافتراضية', 'Added automatically at these points of every job.': 'تُضاف تلقائياً عند هذه النقاط في كل شغلانة.',
    'Output IO at positions': 'مخرج IO عند مواضع', 'Switch a machine output on at a given stitch of a shape.': 'تشغيل مخرج في الماكينة عند غرزة محددة من شكل.',
    'No outputs yet.': 'لا توجد مخرجات بعد.', 'IO on reverse': 'IO أثناء الرجوع', 'Switch an output while the machine sews backwards (back-tacks).': 'تشغيل مخرج أثناء خياطة الماكينة للخلف (الرجوع).',
    'Use an output on reverse stitching': 'استخدام مخرج أثناء الخياطة للخلف', 'Output number': 'رقم المخرج', 'Use': 'الاستخدام', 'Colour': 'اللون',
    'Example: put everything that is embroidered in one layer on Needle 1, and the laser cut lines in another layer on Needle 3.':
      'مثال: ضع كل التطريز في طبقة على الإبرة 1، وخطوط القص بالليزر في طبقة أخرى على الإبرة 3.',
    'New job?': 'شغلانة جديدة؟', 'The current job closes. Save it first if you want to keep it.': 'الشغلانة الحالية ستُغلق. احفظها أولاً لو عايز تحتفظ بيها.', 'New job': 'شغلانة جديدة',
    'Job name': 'اسم الشغلانة', 'Used for the machine file and exports': 'يُستخدم لملف الماكينة والتصدير', 'New layer?': 'طبقة جديدة؟',
    // ---------------------------------------------------------------- command palette
    'Search tools, e.g. back-tack, mirror, machine file': 'ابحث عن أداة، مثلاً: رجوع، عكس، ملف الماكينة', 'Esc': 'Esc',
    'Open file': 'فتح ملف', 'Insert another drawing into the job': 'إدراج رسمة أخرى في الشغلانة', 'Save job': 'حفظ الشغلانة', 'Save job as…': 'حفظ الشغلانة باسم…',
    'Remove overlapping shapes on open': 'حذف الأشكال المتداخلة عند الفتح', 'Work without reference point': 'العمل بدون نقطة مرجعية', 'Drawing resolution (dpi)': 'دقة الرسمة (dpi)',
    'Calculate scale from a measurement': 'حساب المقياس من قياس', 'Machine table size': 'مقاس طاولة الماكينة',
    'Add shape (point, line, rectangle, circle)': 'إضافة شكل (نقطة، خط، مستطيل، دائرة)', 'Move shape to another layer': 'نقل الشكل لطبقة أخرى',
    'Reference point': 'نقطة مرجعية', 'Nudge / move': 'تحريك', 'Mirror': 'عكس', 'Resize selected shapes': 'تغيير حجم الأشكال المحددة',
    'Extend or shorten ends': 'إطالة أو تقصير الأطراف', 'Edit points one by one': 'تعديل النقاط واحدة واحدة', 'Split a shape': 'تقسيم شكل',
    'Delete short lines': 'حذف الخطوط القصيرة', 'Delete selected': 'حذف المحدد', 'Start every shape at top / bottom / left / right': 'ابدأ كل شكل من فوق / تحت / شمال / يمين',
    'Sections: zigzag, back-tack, special length': 'أجزاء: زجزاج، رجوع، طول خاص', 'Measure distance': 'قياس مسافة',
    'Make a layer from the selection (Ctrl+G) ': 'اعمل طبقة من المحدد (Ctrl+G)', 'Delete layer, keep its shapes (Ctrl+Shift+G)': 'حذف الطبقة مع الاحتفاظ بأشكالها (Ctrl+Shift+G)',
    'Set the needle of a layer': 'تحديد إبرة الطبقة', 'Glass effects on / off (off is faster)': 'تشغيل / إيقاف التأثيرات الزجاجية (الإيقاف أسرع)',
    'Make a layer laser cut': 'اجعل طبقة قص ليزر', 'Sewing head (needle 1–3)': 'رأس الخياطة (إبرة 1–3)', 'Closed-shape reinforcement': 'تقوية الأشكال المغلقة',
    'Double stitch length': 'طول الغرزة المزدوج', 'Machine origin': 'نقطة أصل الماكينة', 'Small closed shapes to points': 'تحويل الأشكال المغلقة الصغيرة لنقاط',
    'Copy stitch settings to all layers': 'نسخ إعدادات الغرز لكل الطبقات', 'Sort top → bottom / left → right': 'ترتيب فوق ← تحت / شمال ← يمين',
    'Shortest travel order': 'ترتيب أقصر انتقال', 'Corners on travel moves': 'الزوايا في حركات الانتقال', 'Show sewing order on the drawing': 'عرض ترتيب الخياطة على الرسمة',
    'Program instructions (insert, move, delete)': 'أوامر البرنامج (إدراج، تحريك، حذف)', 'Save machine file (SLW)': 'حفظ ملف الماكينة (SLW)',
    'Export PLT': 'تصدير PLT',
    'Laser speed': 'سرعة الليزر', 'may cut slowly': 'ممكن يقص ببطء', 'ready': 'جاهز', 'This layer may cut slowly.': 'الطبقة دي ممكن تقص ببطء.',
    'Paths are clean: the laser can cut at full speed.': 'المسارات نظيفة: الليزر يقدر يقص بسرعته الكاملة.',
    'Separate cuts': 'عدد القطعات المنفصلة', 'Waiting at cut starts and ends': 'الانتظار عند بداية ونهاية القطعات', 'Points': 'عدد النقاط',
    'Tiny segments (under 0.5 mm)': 'أجزاء صغيرة جداً (أقل من 0.5 مم)', 'Line ends that touch (can be one cut)': 'أطراف خطوط متلامسة (ممكن تبقى قطعة واحدة)',
    'Speed up laser paths': 'تسريع مسارات الليزر',
    'Joins lines that touch into one cut, removes points the cut does not need and cuts in the shortest order. The cut stays within 0.05 mm of the drawing. You can undo it.':
      'يوصّل الخطوط المتلامسة في قطعة واحدة، ويشيل النقط اللي القص مش محتاجها، ويقص بأقصر ترتيب. القص بيفضل في حدود 0.05 مم من الرسمة. وتقدر تتراجع عنه.',
    'Laser layer may cut slowly:': 'طبقة ليزر ممكن تقص ببطء:', 'Fix it in Stitch': 'صلّحها من شاشة الغرز', 'Laser waiting': 'الليزر منتظر',
    'The simulation shows the order and path. ×1 is not the machine\'s real speed; laser pauses show the waits written to the machine file.':
      'المحاكاة بتوضح الترتيب والمسار. ×1 مش سرعة الماكينة الحقيقية؛ وقفات الليزر بتوضح أوقات الانتظار المكتوبة في ملف الماكينة.',
    "Simulation speed (not the machine's real speed)": 'سرعة المحاكاة (مش سرعة الماكينة الحقيقية)', 'of waits': 'منها انتظار', 'DXF / PLT contents': 'محتوى DXF / PLT', 'PLT…': 'PLT…', 'PLT · DXF · SVG · CSV': 'PLT · DXF · SVG · CSV',
    'Export PLT (HPGL plot)': 'تصدير PLT',     'Export DXF': 'تصدير DXF', 'Export picture (SVG)': 'تصدير صورة (SVG)', 'Export stitch list (CSV)': 'تصدير قائمة الغرز (CSV)', 'Language: العربية / English': 'اللغة: العربية / English',
    // ---------------------------------------------------------------- busy and messages
    'Working…': 'جاري العمل…', 'Waiting for the file…': 'في انتظار الملف…', 'Waiting for a file name…': 'في انتظار اسم الملف…', 'Saving to the USB drive…': 'جاري الحفظ على الفلاشة…',
    'Shape added': 'تمت إضافة الشكل', 'Shape duplicated': 'تم نسخ الشكل', 'Layer made': 'تم عمل الطبقة', 'Start point set': 'تم تحديد نقطة البداية',
    'Section added': 'تمت إضافة الجزء', 'Sewing order updated': 'تم تحديث ترتيب الخياطة', 'Sewing order updated for the shortest travel': 'تم تحديث الترتيب لأقصر انتقال',
    'Sewing order now follows the layer list': 'ترتيب الخياطة الآن يتبع ترتيب الطبقات', 'Simulation finished': 'انتهت المحاكاة',
    'Every layer now uses these stitch settings': 'كل الطبقات تستخدم إعدادات الغرز دي الآن', 'Layer removed; its shapes moved to the layer above': 'تم حذف الطبقة ونقل أشكالها للطبقة اللي فوقها',
    'This layer is now laser cut (needle 3)': 'الطبقة دي بقت قص ليزر (الإبرة 3)', 'This layer is now sewn (needle 1)': 'الطبقة دي بقت خياطة (الإبرة 1)',
    'Click a shape where its sewing should start.': 'اضغط على الشكل في المكان اللي تبدأ منه الخياطة.', 'Click on a shape to set where it starts.': 'اضغط على شكل لتحديد بدايته.',
    'Select a shape first — click it on the drawing or in Layers.': 'حدد شكلاً أولاً — اضغط عليه في الرسمة أو في الطبقات.', 'Enter a number.': 'أدخل رقماً.',
    'Nothing to sew yet: turn on a layer with shapes.': 'لا يوجد ما يُخاط بعد: شغّل طبقة فيها أشكال.', 'Select an instruction you inserted (shown in blue).': 'حدد أمراً أضفته (يظهر باللون الأزرق).',
    'Every point needs a number for X and Y.': 'كل نقطة تحتاج رقماً لـ X و Y.', 'Both lengths must be more than 0.': 'الطولان يجب أن يكونا أكبر من 0.', 'Enter a radius.': 'أدخل نصف القطر.',
    'Stitchline lost its connection. Close this window and start Stitchline again.': 'انقطع الاتصال بالبرنامج. أغلق هذا الشباك وشغّل ستيتشلاين مرة أخرى.',
    'That file could not be opened.': 'تعذر فتح هذا الملف.', 'Something went wrong.': 'حدث خطأ ما.', 'New job': 'شغلانة جديدة', 'Undone': 'تم التراجع', 'Redone': 'تمت الإعادة',
    'Nothing to sew: turn on at least one layer.': 'لا يوجد ما يُخاط: شغّل طبقة واحدة على الأقل.', 'That USB drive is no longer connected.': 'الفلاشة لم تعد متصلة.',
    'Select a shape first.': 'حدد شكلاً أولاً.', 'No line ends were close enough to join.': 'لا توجد أطراف خطوط قريبة كفاية للربط.',
    'That would remove the whole line.': 'ده هيمسح الخط كله.', 'Pick a point in the middle of the line to split it.': 'اختر نقطة في منتصف الخط لتقسيمه.',
    'A job needs at least one layer.': 'الشغلانة تحتاج طبقة واحدة على الأقل.', 'This is the only layer; there is nowhere to move its shapes.': 'دي الطبقة الوحيدة؛ لا يوجد مكان لنقل أشكالها.',
    'This file has no drawing in it.': 'هذا الملف لا يحتوي على رسمة.', 'That item no longer exists.': 'هذا العنصر لم يعد موجوداً.',
  };

  // text with names or numbers in it
  const P = [
    [/^(.+) — edited$/, (m, a) => `${a} — معدّل`],
    [/^([\d,]+) needle positions in this layer$/, (m, a) => `${a} نقطة إبرة في هذه الطبقة`],
    [/^(\d+) selected$/, (m, a) => `${a} محدد`],
    [/^(\d+) steps$/, (m, a) => `${a} خطوة`],
    [/^(\d+) start · (\d+) end$/, (m, a, b) => `${a} بداية · ${b} نهاية`],
    [/^(\d+(?:\.\d+)?)° · slow (\d+)(.*)$/, (m, a, b, c) => `${a}° · تبطيء ${b}${c.replace(' · dense', ' · كثيف')}`],
    [/^(\d+)° · dense$/, (m, a) => `${a}° · كثيف`],
    [/^(\d+) st$/, (m, a) => `${a} غرزة`],
    [/^of (\d+)$/, (m, a) => `من ${a}`],
    [/^(\d+) of (\d+) tools$/, (m, a, b) => `${a} من ${b} أداة`],
    [/^(\d+) shapes in (\d+) layers\. Click a shape to edit it\.$/, (m, a, b) => `${a} شكل في ${b} طبقة. اضغط على شكل لتعديله.`],
    [/^Closed shape (\d+)$/, (m, a) => `شكل مغلق ${a}`], [/^Line (\d+)$/, (m, a) => `خط ${a}`], [/^Path (\d+)$/, (m, a) => `مسار ${a}`], [/^Point (\d+)$/, (m, a) => `نقطة ${a}`],
    [/^Shape (\d+)$/, (m, a) => `شكل ${a}`],
    [/^(.+) · ([\d.]+) mm · (\d+) points · (closed|open)$/, (m, a, b, c, d) => `${tr(a)} · ${b} مم · ${c} نقطة · ${d === 'closed' ? 'مغلق' : 'مفتوح'}`],
    [/^([\d.]+) mm in total$/, (m, a) => `${a} مم إجمالي`],
    [/^(\d+) shapes$/, (m, a) => `${a} شكل`],
    [/^Move to (-?[\d.]+), (-?[\d.]+)$/, (m, a, b) => `انتقال إلى ${a}، ${b}`],
    [/^Sew part of “(.+)” differently\. The shape is ([\d.]+) mm long, measured from its start\.$/, (m, a, b) => `خيّط جزءاً من "${tr(a)}" بشكل مختلف. طول الشكل ${b} مم، مقاساً من بدايته.`],
    [/^(.+) · (\d+) points$/, (m, a, b) => `${tr(a)} · ${b} نقطة`],
    [/^Sew (.+)$/, (m, a) => `خياطة ${tr(a)}`],
    [/^Layer change → (.+)$/, (m, a) => `تغيير الطبقة ← ${a}`],
    [/^Needle (\d)( \(laser\))?$/, (m, a, b) => `الإبرة ${a}${b ? ' (ليزر)' : ''}`],
    [/^✓ Needle (\d)$/, (m, a) => `✓ الإبرة ${a}`],
    [/^N(\d)$/, (m, a) => `إ${a}`],
    [/^Output IO (\d+) (on|off)( ✕)?$/, (m, a, b, c) => `مخرج IO ${a} ${b === 'on' ? 'تشغيل' : 'إيقاف'}${c || ''}`],
    [/^Output IO (\d+) at stitch (\d+)$/, (m, a, b) => `مخرج IO ${a} عند الغرزة ${b}`],
    [/^Output IO (\d+) on reverse stitching$/, (m, a) => `مخرج IO ${a} أثناء الخياطة للخلف`],
    [/^Speed goes into the machine file; steps marked “job only” are saved with the job but not written to the machine yet\. Inserted (at the end of the job|before “(.+)”)\. Pick a program step to choose where\.$/,
      (m, a, b) => `السرعة تُكتب في ملف الماكينة؛ الخطوات المعلّمة "في الشغلانة فقط" تُحفظ مع الشغلانة لكن لا تُكتب للماكينة بعد. سيُدرج ${b ? `قبل "${tr(b)}"` : 'في نهاية الشغلانة'}. اختر خطوة من البرنامج لتحديد المكان.`],
    [/^Speed ramp (\d+) → (\d+) rpm$/, (m, a, b) => `تدرج السرعة ${a} ← ${b} لفة/د`],
    [/^(Delay|Speed|Z axis|U axis|Label|Loop|Pause|Thread trim|Presser foot up|Presser foot down|Back to origin|Main shaft position|XY offset move|Input IO|Needle change) (.+?)( ✕)?$/,
      (m, a, b, c) => `${AR[a]} ${b}${c || ''}`],
    [/^(Delay|Speed|Z axis|U axis|Label|Loop|Pause|Thread trim|Presser foot up|Presser foot down|Back to origin|Main shaft position|XY offset move|Input IO|Needle change) ✕$/, (m, a) => `${AR[a]} ✕`],
    [/^Special speed (\d+)$/, (m, a) => `السرعة الخاصة ${a}`],
    [/^SLW · (.+)$/, (m, a) => `SLW · ${a}`],
    [/^X ([\d.]+) · Y ([\d.]+)$/, (m, a, b) => `X ${a} · Y ${b}`],
    [/^(\d+) selected shapes? move into a new layer with its own needle\.$/, (m, a) => `${a} شكل محدد هيتنقل لطبقة جديدة بإبرة خاصة بيها.`],
    [/^Layer “(.+)” is for alignment only \(not sewn\)$/, (m, a) => `الطبقة "${a}" للمحاذاة فقط (لا تُخاط)`],
    [/^“(.+)” and all of its shapes will be removed\. You can undo this\.$/, (m, a) => `"${a}" وكل أشكالها سيتم حذفها. يمكنك التراجع عن ذلك.`],
    [/^Opened (.+?)((?: · .+)*)$/, (m, a, b) => `تم فتح ${a}` + b.replace(/ · (\d+) shapes/, ' · $1 شكل').replace(/ · (\d+) overlaps removed/, ' · حذف $1 تداخل').replace(/ · (\d+) lines joined/, ' · ربط $1 خط')],
    [/^Saved machine file (.+) \((\d+) records\)$/, (m, a, b) => `تم حفظ ملف الماكينة ${a} (${b} سجل)`],
    [/^Saved (.+)$/, (m, a) => `تم حفظ ${a}`],
    [/^Exported (\d+) shapes to (.+)$/, (m, a, b) => `تم تصدير ${a} شكل إلى ${b}`],
    [/^Exported (.+)$/, (m, a) => `تم تصدير ${a}`],
    [/^Inserted (\d+) shapes from (.+)$/, (m, a, b) => `تم إدراج ${a} شكل من ${b}`],
    [/^(\d+) points merged$/, (m, a) => `تم دمج ${a} نقطة`], [/^(\d+) short lines deleted$/, (m, a) => `تم حذف ${a} خط قصير`],
    [/^(\d+) lines joined$/, (m, a) => `تم ربط ${a} خط`], [/^(\d+) overlapping shapes removed$/, (m, a) => `تم حذف ${a} شكل متداخل`],
    [/^(\d+) copies made$/, (m, a) => `تم عمل ${a} نسخة`],
    [/^Scale set to ([\d.]+)×\. Use “Scale drawing now” to apply it to this job\.$/, (m, a) => `تم ضبط المقياس على ${a}×. استخدم "تطبيق المقياس الآن" لتطبيقه على الشغلانة.`],
    [/^Save to USB drive (.+)$/, (m, a) => `حفظ على الفلاشة ${a}`],
    [/^Inserted before “(.+)”\.$/, (m, a) => `سيُدرج قبل "${tr(a)}".`],
    [/^(.+) files cannot be opened\. Supported: (.+)\.$/, (m, a, b) => `لا يمكن فتح ملفات ${a}. الصيغ المدعومة: ${b}.`],
    [/^(.+) files cannot be opened yet\. Save the drawing as DXF and open that\.$/, (m, a) => `لا يمكن فتح ملفات ${a} بعد. احفظ الرسمة كـ DXF وافتحها.`],
    [/^Enter a number for (.+)\.$/, () => 'أدخل رقماً.'],
    [/^Unexpected error: (.+)$/, (m, a) => `خطأ غير متوقع: ${a}`],
    [/^Unknown action: (.+)$/, (m, a) => `إجراء غير معروف: ${a}`],
    [/^Laser paths sped up: (\d+) → (\d+) separate cuts, (\d+) → (\d+) points, (\d+) → (\d+) tiny segments$/,
      (m, a, b, c, d, e, f) => `تم تسريع مسارات الليزر: القطعات ${a} ← ${b}، النقاط ${c} ← ${d}، الأجزاء الصغيرة ${e} ← ${f}`],
    [/^PLT uses the resolution set in Import \(([\d.]+) dpi\)\.$/, (m, a) => `ملف PLT يستخدم الدقة المحددة في الاستيراد (${a} dpi).`],
    [/^(\d+) instr\.$/, (m, a) => `${a} أوامر`],
    [/^stitch (\d+) · IO (\d+)$/, (m, a, b) => `الغرزة ${a} · IO ${b}`],
    [/^(\d+(?:\.\d+)?) m$/, (m, a) => `${a} م`],
    [/^(-?[\d.]+) mm$/, (m, a) => `${a} مم`],
    [/^([\d.]+) × ([\d.]+) mm$/, (m, a, b) => `${a} × ${b} مم`],
  ];

  const UNITS = { mm: 'مم', st: 'غرزة', rpm: 'لفة/د', m: 'م', s: 'ث', dpi: 'dpi', IO: 'IO' };

  function tr(s) {
    if (lang !== 'ar' || !s) return s;
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t || !/[A-Za-z]/.test(t)) return s;
    if (Object.prototype.hasOwnProperty.call(AR, t)) return s.replace(t, AR[t]);
    for (const [re, fn] of P) {
      const m = t.match(re);
      if (m) return s.replace(t, fn(...m));
    }
    return s;
  }
  window.tr = tr;
  window.STL_LANG = lang;
  if (lang !== 'ar') return;

  function translateNode(n) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,input,textarea,[data-notr]')) return;
      const u = p.tagName === 'U' && UNITS[n.nodeValue.trim()];
      if (u) { if (u !== n.nodeValue) n.nodeValue = u; return; }   // write only real changes, or the observer would loop
      const v = tr(n.nodeValue);
      if (v !== n.nodeValue) n.nodeValue = v;
      return;
    }
    if (n.nodeType !== 1) return;
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = n.getAttribute(a);
      if (v) { const t = tr(v); if (t !== v) n.setAttribute(a, t); }
    }
    const walk = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let x;
    while ((x = walk.nextNode())) {
      if (x.nodeType === 3) translateNode(x);
      else for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = x.getAttribute(a);
        if (v) { const t = tr(v); if (t !== v) x.setAttribute(a, t); }
      }
    }
  }
  const obs = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') {
        const v = m.target.getAttribute(m.attributeName);
        const t = tr(v);
        if (v && t !== v) m.target.setAttribute(m.attributeName, t);
      } else m.addedNodes.forEach(translateNode);
    }
  });
  translateNode(document.body);
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
  document.title = 'ستيتشلاين';
})();
