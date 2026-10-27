# R. Daneel — instruções do projeto

## Objetivo e forma de trabalhar

Bot pessoal de WhatsApp, inspirado no robô de Isaac Asimov. Começou com figurinhas
e recebe novas funções incrementalmente. Felipe conhece JavaScript; manter a base
em TypeScript/Node.js, com soluções pequenas e fáceis de operar.

- Responder em português do Brasil, de forma direta.
- Ler os arquivos relevantes antes de editar e preservar alterações existentes.
- Fazer a menor alteração necessária; evitar infraestrutura ou abstrações sem necessidade.
- Não commitar, enviar ao GitHub, publicar ou fazer deploy sem pedido/autorização do usuário.
- Não apagar sessão, volumes ou arquivos pessoais como procedimento de manutenção.
- Ao terminar, informar alterações, validação e limitações. Distinguir teste local,
  teste no container e confirmação real pelo WhatsApp.

## Contexto pessoal do projeto

Ao retomar trabalho relevante no R. Daneel, consulte o índice pessoal definido nas
instruções globais e a nota “Bot pessoal de figurinhas no WhatsApp”, além da
documentação técnica pertinente. Se o índice não estiver disponível, informe a
limitação sem adivinhar o caminho nem bloquear o trabalho técnico independente.

Antes de encerrar uma entrega que altere funcionalidades, arquitetura, hospedagem,
operação ou preferência explícita de Felipe, compare o resultado com essa nota.
Havendo diferença durável, apresente destino, seção e texto concreto da atualização.
Após aprovação específica, aplique pelo helper da skill personal-context, preserve
estado anterior no histórico e releia. Solicite acesso somente para uma gravação
autorizada; a falta de escrita não impede apresentar a proposta.

Sem diferença útil, não gere nota nem aviso burocrático. Não repita proposta ignorada
ou recusada; dados sensíveis exigem confirmação específica. Preferências do bot
permanecem no contexto deste projeto, sem generalização para o perfil pessoal.
O conteúdo da nota pessoal não deve ser incorporado ao repositório.

## Arquitetura

- Node.js 22.12+, TypeScript, módulos ESM/NodeNext.
- Baileys para conexão ao WhatsApp, sem navegador Chromium. Integração não oficial.
- Sharp para figurinhas; processamento local, sem serviço de IA.
- yt-dlp para vídeos públicos de Instagram e Twitter/X; Cobalt como contingência.
- ffprobe valida presença de vídeo e duração no arquivo final.
- Uma fila de processamento, com deduplicação, limite de pedidos e autorização por número.

| Arquivo | Responsabilidade |
|---|---|
| `src/main.ts` | Conexão, eventos, fila, envio e reconexão |
| `src/access.ts` | Leitura e validação da lista privada de autorizados |
| `src/request.ts` | Autorização, comandos e extração do pedido |
| `src/sticker.ts` | Conversão de imagens |
| `src/animated-sticker.ts` | Vídeo/GIF para WebP animado, validação e limites |
| `src/video.ts` | Download, limites, validação e limpeza |
| `src/cobalt.ts` | Cliente da API Cobalt |
| `test/` | Testes com o runner nativo do Node |
| `compose.server.yaml` | Bot e Cobalt na Oracle |
| `compose.yaml` | Execução experimental com volume de sessão independente |
| `docs/servidor-oracle.md` | Procedimentos de operação do servidor |

## Comportamento a preservar

- Apenas números autorizados e conversas privadas; ignorar grupos, mensagens próprias,
  histórico, status e mídia de visualização única.
- Falha ao carregar a lista deve impedir a inicialização, nunca liberar acesso geral.
- Preservar a resolução de identificadores LID e a equivalência restrita do nono
  dígito brasileiro. Não ampliar correspondência de números por suposição.
- `!figurinha` deve ser a legenda da foto, vídeo ou GIF.
- Animações: entrada de até 10 MiB e 0,2–10 segundos; recusar duração maior sem cortar.
  Saída WebP animada 512×512 de até 500.000 bytes, em loop, com ao menos dois quadros,
  mínimo de 8 ms por quadro e duração total de até 10 segundos. Enviar com `isAnimated: true`.
  Preservar validação antes/depois da conversão, threads limitadas, timeouts e limpeza.
- Figurinhas: JPEG, PNG ou WebP estático, até 10 MiB e 25 milhões de pixels;
  saída WebP de 512×512 e até 100.000 bytes, sem metadados.
- Corrigir orientação EXIF antes de decidir o formato. Fotos verticais preenchem
  o quadrado com achatamento (`fill`), sem corte. Horizontais usam `contain`.
- Vídeos: link isolado ou `!video <link>`; apenas URLs validadas dos serviços suportados.
  Limite final de 16 MiB e 180 segundos. Duração ausente nos metadados não deve
  impedir o download; verificar com ffprobe depois.
- Falha de download pode acionar Cobalt; falha de envio no WhatsApp não deve baixar de novo.
- Limpar arquivos temporários após sucesso ou falha; manter limites e timeouts.
- Executar subprocessos com argumentos separados, sem interpolar mensagens em shell.

## Segurança e dados privados

- `.env`, `allowed-numbers.json`, `data/`, `.tools/`, dependências e compilados
  devem permanecer fora do Git. Conferir também o contexto Docker.
- `data/auth/` contém credenciais da conta. Nunca imprimir, publicar ou enviar seu
  conteúdo a outro serviço sem autorização específica.
- Não registrar telefones, textos de conversas, QR codes, cookies, tokens ou chaves nos logs.
- Não copiar números reais para exemplos ou testes; usar dados fictícios.
- Manter uma única instância conectada à mesma sessão: Mac e Oracle não podem
  executar simultaneamente.
- A chave SSH local fica em `data/ssh/`, com permissão 600; nunca registrar seu conteúdo.
- Cobalt deve permanecer interno. Não publicar sua porta nem usar instâncias
  públicas de terceiros sem autorização do operador.
- Não usar cookies de navegador ou contas pessoais implicitamente para downloads.

## Validação

```sh
npm ci
npm run check
```

`check` compila e executa os testes. Adicionar testes quando houver mudança real
em autorização, processamento ou tratamento de falhas. Para alterações somente
em documentação, revisar o texto sem repetir testes desnecessariamente.

Validar orientação, proporção, limites e limpeza ao alterar mídia. Não iniciar
uma segunda conexão WhatsApp para executar testes de conversão ou download.
Preferir importar os módulos isoladamente. Não enviar mensagens de teste a terceiros
sem instrução explícita.

## Operação e deploy

Servidor: Oracle Always Free, Ubuntu 24.04 x86_64, E2.1.Micro, 1 GB RAM,
disco de 47 GB e 1 GB de swap. Configuração registrada em outubro/2026;
verificar o estado real antes de operar. Diretório: `/home/ubuntu/r-daneel-whatsapp`.
Endereço da VM: consultar no painel Oracle, sem fixá-lo no código.

- Usar `compose.server.yaml` no servidor. O Compose experimental usa outro volume
  e não reaproveita automaticamente a sessão migrada.
- Bot: imagem `r-daneel-bot:local`; Cobalt: imagem oficial fixada por digest.
- Sessão em `./data/auth`, lista em `./allowed-numbers.json`, montadas fora da imagem.
- Usuário do bot no container: UID/GID 1000. Garantir propriedade e permissões
  adequadas, inclusive da lista privada (600).
- Após editar a lista no mesmo arquivo, reiniciar o bot. Após substituir o arquivo
  por outro inode (ex.: transferência/install), recriar o container para renovar o bind mount.
- Reinício automático: `unless-stopped`; logs com rotação. Não adicionar portas públicas.
- VM pequena: medir consumo e picos. Swap não substitui RAM. Build pode ser lento.

Fluxo de atualização, quando autorizado:

1. Conferir `git status` e diferenças no Mac e no servidor; preservar mudanças locais.
2. Rodar `npm run check` e enviar apenas o código aprovado ao GitHub.
3. No servidor, `git pull --ff-only origin main`. Se houver alterações locais,
   parar e reconciliar sem descarte automático.
4. Construir a imagem com o bot atual ainda funcionando:

```sh
sudo docker build -t r-daneel-bot:local .
```

5. Somente após build bem-sucedido, aplicar e conferir:

```sh
sudo docker compose -f compose.server.yaml up -d --force-recreate bot
sudo docker compose -f compose.server.yaml logs --tail 20 bot
sudo docker compose -f compose.server.yaml ps
```

Confirmar “R. Daneel conectado” e testar os recursos afetados. Não confundir container
iniciado com conexão estabelecida. Preservar a sessão e um caminho de rollback.

Em outubro/2026 houve atualização direta do módulo de figurinhas na imagem do servidor.
Antes do próximo pull/deploy, verificar se essas diferenças e os arquivos de deploy
já foram incorporados ao GitHub; não pressupor que servidor e remoto estão sincronizados.

A persistência Baileys atual é baseada em arquivos e tem limitações. Não substituir
por infraestrutura mais complexa sem necessidade concreta. Downloads podem falhar por
restrições ou reputação do IP; não prometer acesso a todo conteúdo público.

## Comandos e atalhos

- `!figurinha` / `!f`: legenda de foto, vídeo ou GIF para criar figurinha.
- `!video <link>` / `!v <link>`: baixar vídeo público do Instagram ou Twitter/X.
- `!vfigurinha <link>` / `!vf <link>`: baixar uma vez e enviar o vídeo completo seguido de figurinha animada.
- Link isolado continua retornando somente o vídeo. Comandos aceitam maiúsculas e espaços nas extremidades.
- No comando combinado, a figurinha usa os primeiros 10 segundos, com aviso quando houver recorte.
  O vídeo completo mantém os limites de 16 MiB e 3 minutos. O trecho é preparado localmente,
  sem áudio, e passa pela validação de entrada de 10 MiB e compressão progressiva até 500.000 bytes.
- O envio direto com `!figurinha`/`!f` continua recusando animações acima de 10 segundos.
- Uma falha na figurinha após enviar o vídeo é informada separadamente, sem baixar novamente.
