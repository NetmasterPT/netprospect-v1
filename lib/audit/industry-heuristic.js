// lib/audit/industry-heuristic.js
// Classificador de ÁREA DE ATIVIDADE por keywords ponderadas — substituto do Ollama para
// o batch. O Ollama em CPU levava 107 s/site (26 dias p/ os 729k) e roubava CPU ao Lighthouse.
// Isto é ~instantâneo, corre no role `base` (network-bound, sem GPU) e é "bom o suficiente"
// para SEGMENTAR (que é o uso: filtrar audiências, não uma verdade legal). Mesma TAXONOMY e
// mesmo output ({ industry, confidence }) do classificador Ollama → drop-in.
//
// Método: conta ocorrências das keywords de cada categoria no título+descrição+texto (o título
// pesa mais). Devolve a categoria com mais pontos; confiança = margem sobre a 2.ª. Sem sinal
// forte → 'outros' com confiança baixa. Palavras acentuadas e não-acentuadas ambas cobertas.

import { TAXONOMY } from './ollama-classify.js';

// Keywords por categoria (pt + alguns termos en comuns em sites .pt/.nl/.se…). Curadas para
// ALTA precisão (evitar falsos positivos) — termos genéricos ficam de fora de propósito.
const KW = {
  restauracao: ['restaurante', 'ementa', 'menu do dia', 'marisqueira', 'churrasqueira', 'pizzaria', 'gelataria', 'pastelaria', 'padaria', 'take away', 'takeaway', 'catering', 'tasca', 'cervejaria', 'restaurant', 'reservas'],
  retalho: ['loja online', 'carrinho', 'adicionar ao cesto', 'add to cart', 'checkout', 'produtos', 'coleção', 'coleccao', 'promoções', 'promocoes', 'stock', 'webshop', 'e-commerce', 'ecommerce', 'comprar agora'],
  saude: ['clínica', 'clinica', 'médico', 'medico', 'dentária', 'dentaria', 'dentista', 'consulta', 'fisioterapia', 'psicólog', 'psicolog', 'enfermagem', 'farmácia', 'farmacia', 'saúde', 'saude', 'ortodontia', 'implantes', 'veterinári', 'veterinari', 'nutricion'],
  construcao: ['construção', 'construcao', 'obras', 'remodelaç', 'remodelac', 'empreitada', 'pedreiro', 'canaliza', 'eletricista', 'electricista', 'pladur', 'alvenaria', 'engenharia civil', 'terraplenagem', 'demoliç'],
  imobiliario: ['imobiliária', 'imobiliaria', 'imóvel', 'imovel', 'imóveis', 'imoveis', 'arrendamento', 'venda de casa', 'apartamento t', 'moradia', 'real estate', 'mediação imobil', 'consultor imobil'],
  turismo: ['hotel', 'alojamento', 'guest house', 'guesthouse', 'turismo rural', 'reservar estadia', 'quartos', 'booking', 'hostel', 'resort', 'férias', 'ferias', 'passeios', 'tours', 'excurs'],
  juridico: ['advogad', 'advocacia', 'jurídic', 'juridic', 'sociedade de advog', 'solicitador', 'notário', 'notario', 'law firm', 'contencioso', 'litígio', 'litigio'],
  contabilidade: ['contabilidade', 'contabilista', 'toc ', 'roc ', 'fiscalidade', 'irs', 'iva', 'gestão contab', 'accounting', 'processamento salários', 'processamento salarios'],
  automovel: ['automóvel', 'automovel', 'stand auto', 'oficina auto', 'pneus', 'peças auto', 'pecas auto', 'bateria', 'mecânic', 'mecanic', 'car ', 'viatura', 'concessionári', 'reboque', 'lavagem auto'],
  beleza: ['cabeleireiro', 'cabeleireira', 'estética', 'estetica', 'salão de beleza', 'salao de beleza', 'manicure', 'barbearia', 'spa ', 'massagem', 'depilaç', 'unhas de gel', 'maquilhagem', 'barber'],
  educacao: ['escola', 'formação', 'formacao', 'explicações', 'explicacoes', 'curso', 'cursos', 'academia de', 'centro de estudos', 'jardim de infância', 'jardim de infancia', 'creche', 'ensino', 'workshop', 'e-learning', 'universidade', 'training'],
  ti: ['software', 'desenvolvimento web', 'aplicações', 'aplicacoes', 'aplicação móvel', 'app móvel', 'cibersegurança', 'ciberseguranca', 'cloud', 'servidor', 'programação', 'programacao', 'sistemas informát', 'ti ', 'it services', 'saas', 'plataforma digital', 'informática', 'informatica'],
  marketing: ['marketing digital', 'publicidade', 'agência de comunicaç', 'agencia de comunicac', 'redes sociais', 'social media', 'seo', 'branding', 'design gráfico', 'design grafico', 'gestão de redes', 'campanhas', 'copywriting', 'agência criativa'],
  industria: ['fábrica', 'fabrica', 'produção industrial', 'producao industrial', 'metalomecânic', 'metalomecanic', 'moldes', 'injeção', 'injecao', 'maquinaria', 'linha de produção', 'linha de producao', 'manufatura', 'industrial', 'fundição', 'fundicao'],
  agricultura: ['agrícola', 'agricola', 'agricultura', 'vinha', 'adega', 'vinho', 'azeite', 'olival', 'quinta', 'pecuária', 'pecuaria', 'hortícola', 'horticola', 'colheita', 'fruticultura', 'viveiro'],
  transportes: ['transportes', 'transportadora', 'logística', 'logistica', 'mudanças', 'mudancas', 'distribuição', 'distribuicao', 'frota', 'táxi', 'taxi', 'estafeta', 'entregas', 'expedição', 'freight', 'shipping'],
  desporto: ['ginásio', 'ginasio', 'fitness', 'crossfit', 'clube desportivo', 'futebol', 'ténis', 'tenis', 'natação', 'natacao', 'personal trainer', 'modalidades', 'piscina', 'treino', ' ténis '],
  moda: ['moda', 'vestuário', 'vestuario', 'roupa', 'calçado', 'calcado', 'acessórios de moda', 'boutique', 'coleção outono', 'joalharia', 'ourivesaria', 'malas', 'fashion', 'atelier de costura'],
  casa: ['mobiliário', 'mobiliario', 'decoração', 'decoracao', 'móveis', 'moveis', 'cozinhas', 'iluminação', 'iluminacao', 'jardinagem', 'jardim', 'piscinas', 'climatização', 'climatizacao', 'estores', 'interiores'],
  financeiro: ['seguros', 'mediador de seguros', 'crédito', 'credito', 'investimento', 'contas poupança', 'banco', 'financiamento', 'leasing', 'consultoria financeira', 'gestão de patrim', 'gestao de patrim', 'insurance'],
  associacao: ['associação', 'associacao', 'fundação', 'fundacao', 'sem fins lucrativos', 'ong ', 'voluntariado', 'ipss', 'coletividade', 'colectividade', 'federação', 'federacao', 'sindicato', 'cooperativa', 'junta de freguesia', 'câmara municipal', 'camara municipal'],
};

const norm = (s) => (s || '').toLowerCase();

// input: o objeto do summarizeForClassify ({ title, description, text }) OU uma string.
export function classifyIndustryHeuristic(input) {
  const s = typeof input === 'string' ? { text: input } : (input || {});
  const title = norm(s.title);
  const body = norm([s.description, s.text].filter(Boolean).join(' '));
  if (!title && !body) return { industry: null, confidence: null };

  const scores = {};
  for (const cat of TAXONOMY) {
    if (cat === 'outros') continue;
    let sc = 0;
    for (const kw of (KW[cat] || [])) {
      // título pesa 3× (é o sinal mais forte da atividade principal)
      if (title.includes(kw)) sc += 3;
      // ocorrências no corpo (contadas, com teto p/ não deixar 1 palavra dominar)
      const n = body.split(kw).length - 1;
      if (n > 0) sc += Math.min(n, 3);
    }
    if (sc > 0) scores[cat] = sc;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { industry: 'outros', confidence: 0.2 };

  const [top, topScore] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  // confiança = força do sinal × margem sobre o 2.º lugar (0.4–0.95)
  const margin = (topScore - second) / topScore;
  const confidence = Math.min(0.95, Math.max(0.4, 0.45 + 0.1 * Math.min(topScore, 4) + 0.25 * margin));
  return { industry: top, confidence: Number(confidence.toFixed(2)) };
}
