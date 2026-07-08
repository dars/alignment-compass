// 9 大陣營顯示用中繼資料（個人化分析由 AI 產生，這裡只放固定資訊）
const ALIGNMENTS = {
  LG: { zh: "守序善良", en: "Lawful Good", title: "聖者", examples: "超人、美國隊長、奈德・史塔克（權力遊戲）、布蕾妮（權力遊戲）、典型的聖騎士", hint: "以規則行善，秩序是守護弱者的盾。" },
  NG: { zh: "中立善良", en: "Neutral Good", title: "仁者", examples: "甘道夫、神力女超人、蜘蛛人、哈利波特", hint: "行善不問形式，良心即是律法。" },
  CG: { zh: "混亂善良", en: "Chaotic Good", title: "義俠", examples: "羅賓漢、韓索羅、魯夫（航海王）、星爵（星際異攻隊）", hint: "心向自由，也向弱者伸出手。" },
  LN: { zh: "守序中立", en: "Lawful Neutral", title: "執法者", examples: "包青天、史巴克（星際爭霸戰）、特警判官爵德、嚴格的僧侶與法官", hint: "法則高於善惡，承諾重於一切。" },
  TN: { zh: "絕對中立", en: "True Neutral", title: "均衡者", examples: "傑洛特（獵魔士）、曼哈頓博士（守護者）、德魯伊教團、樹人", hint: "不偏不倚，順勢而為，維持平衡。" },
  CN: { zh: "混亂中立", en: "Chaotic Neutral", title: "浪客", examples: "傑克・史派羅船長、洛基、死侍、哈莉・奎茵", hint: "自由至上，規則只是參考。" },
  LE: { zh: "守序邪惡", en: "Lawful Evil", title: "霸主", examples: "達斯・維達、泰溫・蘭尼斯特（權力遊戲）、恩不里居（哈利波特）、魔鬼契約師", hint: "在體制內攫取權力，契約是武器。" },
  NE: { zh: "中立邪惡", en: "Neutral Evil", title: "利己者", examples: "佛地魔、小指頭（權力遊戲）、刀疤（獅子王）、唯利是圖的傭兵", hint: "利益優先，手段不拘。" },
  CE: { zh: "混亂邪惡", en: "Chaotic Evil", title: "毀滅者", examples: "小丑、貝拉・雷斯壯（哈利波特）、拉姆齊・波頓（權力遊戲）、失控的惡魔崇拜者", hint: "慾望與破壞，不受任何約束。" },
};

// 3×3 陣營表的排列順序（列：善良→邪惡，欄：守序→混亂）
const GRID_ORDER = ["LG", "NG", "CG", "LN", "TN", "CN", "LE", "NE", "CE"];
