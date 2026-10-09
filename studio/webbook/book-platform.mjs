// Infer only recognized course metadata; explicit per-book settings take priority.
export function inferBookPlatform(book) {
 const name=String(book?.name||'');
 const match=/HSK[\s_-]*([1-6])/i.exec(name);
 const level=match?.[1];
 const workbook=/work\s*book|\bWB\b|тетрад|练习册/i.test(name);
 const legacy=level==='1'&&/v?3[._]0|3\.0|HSK Course 1/i.test(name);
 const inferred=level?{level:`HSK ${level}`,section:`HSK ${level}${legacy?' v3.0':''}${workbook?' · Рабочая тетрадь':''}`,slug:`hsk${level}${legacy?'-v3':''}${/上/.test(name)?'-upper':''}${workbook?'-workbook':''}`}:{level:'',section:name,slug:`book-${book.id}`};
 return {...inferred,...book.platform};
}
