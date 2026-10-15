# Deface CT

Desidentificação facial de TC de crânio no navegador. Recebe lotes de até **100 exames** (um ZIP DICOM por exame), escolhe a série correta, identifica **olhos, nariz, boca e mento**, substitui a superfície da face por uma **face genérica idêntica para todos** e devolve os DICOM desidentificados, exame a exame ou **todos em um único ZIP**.

**Processamento 100% local.** Imagens, arquivos DICOM e dados do paciente nunca saem do navegador nem do dispositivo de quem usa. O único dado transmitido é o e-mail informado, para validar o acesso. No site publicado, a política de segurança (`connect-src 'self'`) impede a página de enviar dados a qualquer outro endereço.

HMN Educação em Saúde · Dr. Heraldo O. Mello Neto

<img width="1075" height="618" alt="image" src="https://github.com/user-attachments/assets/a7b5bb36-0b51-48b5-b720-cd2f680dfdd4" />
<img width="1110" height="635" alt="image" src="https://github.com/user-attachments/assets/b7a87c3b-00b0-462c-a622-730221e273de" />
<img width="1113" height="627" alt="image" src="https://github.com/user-attachments/assets/60f7db6c-0757-4788-8c18-71bc87dd880c" />
<img width="1122" height="339" alt="image" src="https://github.com/user-attachments/assets/1c979d5c-6d84-41fc-b1b3-5be5ae3a10e1" />

## Desidentificação facial sem prejuízo de perda de estruturas corporais.
Deface CT que restringe-se à superfície facial, sem perda das estruturas abaixo do plano da pele.
Embaralhamento de ✓ Olhos ✓ Nariz ✓ Boca ✓ Mento

## Uso

1. Abra o site no **Google Chrome** (computador). Acesse: https://glittering-platypus-0a0877.netlify.app/
2. **Acesso:** informe o e-mail. Um código de 6 dígitos é enviado na hora e libera o processamento.
3. **Configuração do lote:**
   - pasta de destino (recomendado: os ZIPs vão direto para o disco);
   - nome das pastas: código sequencial `DEFACE_001…` ou número de acesso original;
   - anonimização do cabeçalho (padrão: ligada);
   - tabela CSV de correspondência (opcional, sempre fora do ZIP).
4. **Exames:** arraste até 100 ZIPs e clique em *Iniciar processamento*. Use *Pausar*, *Cancelar* ou *Reprocessar com erro* quando precisar.
5. **Conferência visual:** compare Original × Desidentificado em 3D. Durante a rotação a imagem usa 1/5 da resolução e volta à resolução completa ao parar. Abaixo ficam os cortes sagital e axial de controle.
6. **Download:** *Baixar tudo (ZIP único)* gera `DEFACE_lote_AAAAMMDD_HHMM.zip` com uma pasta por exame (ZIP64, sem limite de 4 GB). Exames que precisam de decisão são listados antes:
   - face não identificada: incluir sem alterar a face ou excluir;
   - só havia série com contraste: incluir ou excluir.

## Regras de seleção da série

- Só séries **volumétricas axiais de TC** são aceitas: espaçamento ≤ 2 mm, ≥ 30 cortes, cobertura ≥ 5 cm, geometria consistente.
- Scout/localizador, multiframe (Enhanced CT), séries espessas e reformatações não axiais são descartados.
- Entre as válidas, a escolha segue esta ordem:
  1. **sem contraste** (agente de contraste no cabeçalho ou descrição da série);
  2. **menor kernel**: valor numérico (J30s, H31s, FC21…) ou nome (SOFT < STANDARD < BONE…);
  3. menor espaçamento;
  4. mais cortes.
- Um ZIP com vários estudos gera um resultado para cada estudo.

## Método

| Etapa | Implementação |
|---|---|
| Pele | Por corte, maior componente acima de −500 UH (exclui mesa/suporte); profundidade anterior com interpolação subvoxel |
| Nariz | Maior proeminência anterior em relação à superfície suavizada (σ 20 mm), na faixa da linha média |
| Olhos | Maior esfera de partes moles (−25 a 65 UH, após média 3×3×3) em cada órbita, anterior ao 1º osso, por transformada de distância 3D; validação por distância interocular e posição em relação ao nariz |
| Boca / mento | Rima labial = recesso entre proeminências no perfil mediano; mento = ponto mais anterior abaixo dela (sinalizados quando fora do volume) |
| Face genérica | Base polinomial 2D grau 3 (IRLS robusto) + relevo de manequim com dimensões fixas, ancorado na linha dos olhos |
| Proteção | Nunca altera osso/dentes (> 250 UH) nem os globos oculares (esfera de raio ≥ 12,5 mm); a nova pele fica ≥ 1 mm anterior ao osso e ≥ 2,5 mm anterior aos globos |
| Envelope ±2 voxels | Todos os voxels entre a pele original e a nova, mais 2 voxels para dentro e 2 no ar, recebem amostras aleatórias de ar e de partes moles do próprio exame, com transição de volume parcial e variação aleatória |
| Saída | Mesma geometria, sem perdas (Explicit VR LE, ou Implicit se a origem for Implicit), nova série `… DEFACE`, novos UIDs. A anonimização opcional remove nome, ID, nascimento, instituição, médicos e tags privadas |

- **Decodificadores:** JPEG 2000 (OpenJPEG), JPEG-LS (CharLS), JPEG Lossless, RLE, Deflate e não comprimido.
- **Não suportado:** multiframe (Enhanced CT), Big Endian, HTJ2K, JPEG com perdas.

## Publicação (GitHub + Netlify)

1. No Netlify: *Add new site → Import an existing project* → este repositório. Não é preciso comando de build. O `netlify.toml` já define `publish = "."`, as funções e os cabeçalhos.
2. Para ativar a validação por e-mail, cadastre em *Site configuration → Environment variables*:
   - Envio pelo **Gmail**:
     - `SMTP_USER`: o endereço do Gmail.
     - `SMTP_PASS`: uma *senha de app*. Ative a verificação em duas etapas e crie a senha em <https://myaccount.google.com/apppasswords>.
     - `MAIL_FROM` (opcional): por exemplo, `Deface CT <seuemail@gmail.com>`.
     - `SMTP_HOST`/`SMTP_PORT` só são necessários fora do Gmail. O padrão é `smtp.gmail.com:465`.
   - Envio pelo **Resend** (alternativa): `RESEND_API_KEY` e `MAIL_FROM` com um domínio verificado.
   - `CODE_SECRET` é opcional: sem ele, a função gera um segredo aleatório na primeira execução e o guarda no Netlify Blobs.
   - Enquanto o remetente não estiver cadastrado, o site funciona normalmente e mostra um aviso de que a validação ainda não foi ativada.
3. Faça um novo deploy (*Deploys → Trigger deploy*).

Sobre o funcionamento:

- Os e-mails validados ficam registrados no Netlify Blobs (loja `deface-ct-verify`, chaves `user:*`).
- Limites:
  - 5 códigos por e-mail por hora e 20 por IP por hora;
  - 5 tentativas por código;
  - o código expira em 10 minutos e a sessão em 30 dias.
- Publicado só como `index.html` (Netlify Drop), o site funciona em **modo de pré-visualização**: o processamento fica liberado e não há validação de e-mail, porque as funções não existem nesse modo.

## Desenvolvimento

```bash
npm install
npm run build                        # gera index.html (arquivo único)
node build-test.mjs                  # pacote do motor para testes em Node
python3 test/make_phantom.py data/p1.zip --multi --ts j2k   # fantoma de TC sintético
node test/run.cjs data/p1.zip out/p1 # processa em Node
python3 test/validate.py data/p1.zip out/p1/DEFACE_001.zip "CRANIO S/C 1.0 J30s"
node test/verify.test.mjs            # verificação de e-mail
node test/e2e.mjs --mode functions --files data/p1.zip --csv   # ponta a ponta no Chromium
```

Código-fonte em `src/`:

| Arquivo | Conteúdo |
|---|---|
| `dicom.js` | E/S DICOM |
| `codecs.js` | Decodificadores |
| `series.js` | Escolha da série |
| `volume.js` | Volume e escrita |
| `deface.js` | Algoritmo de desidentificação |
| `render.js` | Renderização 3D |
| `zipread.js` / `zipwrite.js` | ZIP com suporte a ZIP64 |
| `worker.js` | Motor em Web Worker |
| `app.js` / `app.html` / `i18n.js` | Interface PT/EN, tema claro/escuro |

As funções ficam em `netlify/`.

> Ferramenta de apoio para pesquisa, ensino e compartilhamento de dados. Confira visualmente cada resultado antes de divulgar. Orelhas e contorno craniano não são alterados.
