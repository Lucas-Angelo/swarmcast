# Publicação (mantenedor)

## 1. Repositório

O repositório já existe e está privado: `Lucas-Angelo/swarmcast`. Se precisar criar do zero:

```sh
gh repo create Lucas-Angelo/swarmcast --private --source . --remote origin
git push -u origin main
```

Enquanto ele estiver privado, os assets das releases exigem login no GitHub. Por isso os comandos de uma linha (`irm … | iex`, `curl … | bash`) não funcionam para a streamer. Use o zip de instalação (seção 4) ou o espelho público (seção 5).

Para deixá-lo público (aí os comandos de uma linha funcionam direto no próprio repositório):

```sh
gh repo edit Lucas-Angelo/swarmcast --visibility public --accept-visibility-change-consequences
```

## 2. Proteção da branch `main`

Exija PR e os checks do CI. Use como `contexts` os nomes dos jobs definidos em `.github/workflows/ci.yml`; os nomes abaixo são exemplos:

```sh
gh api -X PUT repos/Lucas-Angelo/swarmcast/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["lint-typecheck", "unit", "integration", "e2e"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

Em repositório privado, a proteção de branch exige um plano pago do GitHub. Em repositório público, é grátis.

## 3. Lançar uma versão

1. Atualize a versão em `package.json` e o `CHANGELOG.md`, e faça merge na `main`.
2. Crie e envie a tag:
   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. O workflow de release (`.github/workflows/release.yml`) roda sozinho:
   1. Compila e testa em Windows, macOS (arm64 e x64) e Linux (x64 e arm64).
   2. Gera os pacotes `SwarmCast-v0.1.0-<plataforma>.zip|tar.gz`.
   3. Assina os binários se os secrets existirem.
   4. Monta um zip de instalação por plataforma: `SwarmCast-v0.1.0-<plataforma>-installer.zip`.
   5. Gera o `SHA256SUMS.txt` de tudo e publica em **GitHub → Releases** (`https://github.com/Lucas-Angelo/swarmcast/releases/latest`), junto com `start-windows.ps1`, `start-windows.cmd`, `start-macos.command`, `start-macos.sh` e `start-linux.sh`.
   6. Se o espelho público estiver configurado (seção 5), publica a mesma release nele.

Cada zip de instalação tem:
- o script da plataforma (`start-windows.cmd` + `start-windows.ps1`, `start-macos.command` ou `start-linux.sh`);
- o pacote da plataforma;
- um `SHA256SUMS.txt` só com a linha do pacote;
- um `README.txt` curto (inglês e português);
- o guia completo da live em HTML: `LEIA-ME - Como fazer a live.html` e `READ-ME - How to go live.html`. Eles são gerados a partir das páginas do site (`site/src/content/docs/`, lista e ordem em `site/offline-guide.json`) por `scripts/build/guide-html.mjs`. Para mudar o guia, edite as páginas do site: o site e o guia offline sempre dizem a mesma coisa.

Quando o script roda ao lado do `SHA256SUMS.txt` e do pacote, ele instala a partir desses arquivos locais. Ele confere o SHA-256 do mesmo jeito, troca a instalação de forma atômica e não baixa nada. Mesmo assim, consulta uma vez o endereço online padrão: se houver versão mais nova lá, usa a online; se não conseguir acessar (repositório privado dá 404), segue com o zip sem erro.

Ordem de prioridade da origem: variável `SWARMCAST_RELEASE_URL` > zip local ao lado do script > endereço online padrão. O script mostra qual origem está usando ("Install source: …").

## 4. O que mandar para a streamer (Discord)

**Repositório privado (agora):** mande o zip de instalação da plataforma dela.

1. Baixe o zip certo da release (você está logado no GitHub):
   ```sh
   gh release download v0.1.0 -R Lucas-Angelo/swarmcast -p 'SwarmCast-v0.1.0-windows-x64-installer.zip'
   ```
   Troque `windows-x64` por `macos-arm64` (Mac M1–M4), `macos-x64` (Mac Intel) ou `linux-x64`.
2. Envie o zip pelo Discord. O zip tem dezenas de MB, mais do que o limite de upload do Discord sem Nitro. Se não couber, suba o arquivo no Google Drive, OneDrive ou WeTransfer e mande o link no Discord (de preferência em mensagem privada). O conteúdo é verificado pelo SHA-256 do `SHA256SUMS.txt` dentro do zip, então um arquivo corrompido no caminho é recusado. Isso não protege contra alguém que troque o zip inteiro (pacote e `SHA256SUMS.txt` juntos), então envie por um canal em que ela confie, direto de você. Se quiser, mande também o hash do zip, tirado do `SHA256SUMS.txt` principal da release, para ela conferir.
3. Diga para ela: "Extraia o zip, abra a pasta e dê dois cliques no `start-windows.cmd` (Mac: `start-macos.command`). O passo a passo completo está no arquivo `LEIA-ME - Como fazer a live.html` dentro da pasta."

Na primeira vez, o Windows (SmartScreen) e o macOS (Gatekeeper) avisam que o arquivo veio da internet. O guia explica como liberar: no Windows, **Mais informações → Executar assim mesmo**; no macOS, botão direito → **Abrir** (no macOS 15 ou mais novo: **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**). O script remove a marca de quarentena só dos arquivos que ele verificou pelo SHA-256.

**Com o espelho público ou repositório público:** os comandos de uma linha passam a funcionar. Com o espelho, use o endereço dele (troque `Lucas-Angelo/swarmcast-releases` pelo valor de `RELEASES_REPO`):
- Windows (PowerShell): `irm https://github.com/Lucas-Angelo/swarmcast-releases/releases/latest/download/start-windows.ps1 | iex`
- macOS: `curl -fsSL https://github.com/Lucas-Angelo/swarmcast-releases/releases/latest/download/start-macos.sh | bash`
- Linux: `curl -fsSL https://github.com/Lucas-Angelo/swarmcast-releases/releases/latest/download/start-linux.sh | bash`

Com o repositório público (sem espelho), use `Lucas-Angelo/swarmcast` no lugar.

Mande junto o link do guia: <https://lucas-angelo.github.io/swarmcast/pt-br/> (ou aponte para o HTML dentro do zip).

**Atualizações:** com o zip, mande o zip novo; ela extrai e roda o script do mesmo jeito. Com o espelho ou repositório público, basta ela rodar o mesmo script ou comando de novo. Nos dois casos o script confere o SHA-256, troca a instalação de forma atômica (volta para a anterior se algo falhar), mantém as configurações e abre o app. Um zip antigo nunca rebaixa uma versão mais nova já instalada.

## 5. Espelho público das releases (opcional, desligado por padrão)

Serve para os comandos de uma linha funcionarem com o código ainda privado. O espelho só recebe os assets e as notas da release, nunca o código.

1. Crie o repositório público com pelo menos um commit (a tag é criada na branch padrão dele):
   ```sh
   gh repo create Lucas-Angelo/swarmcast-releases --public --add-readme --description "SwarmCast release downloads"
   ```
2. Crie um token *fine-grained* em **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**: acesso só ao repositório `swarmcast-releases`, permissão **Contents: Read and write**, validade curta (renove quando vencer).
3. No repositório privado, cadastre:
   ```sh
   gh variable set RELEASES_REPO -R Lucas-Angelo/swarmcast --body 'Lucas-Angelo/swarmcast-releases'
   gh secret set RELEASES_REPO_TOKEN -R Lucas-Angelo/swarmcast   # cole o token
   ```
4. Na próxima tag, o job de publicação:
   1. Troca, só nas cópias publicadas dos scripts (e nos guias HTML dos zips), o endereço padrão `github.com/Lucas-Angelo/swarmcast/releases` por `github.com/Lucas-Angelo/swarmcast-releases/releases`. Os arquivos fonte não mudam.
   2. Cria a release no repositório privado, como sempre.
   3. Cria a mesma release no espelho com `gh release create -R "$RELEASES_REPO"`.

Por que reescrever o endereço: os scripts têm um único endereço padrão. Com o espelho, os scripts publicados (inclusive os de dentro dos zips) passam a procurar atualizações no espelho, e os comandos de uma linha funcionam.

Para desligar, apague a variável `RELEASES_REPO` ou o secret `RELEASES_REPO_TOKEN`. As releases antigas do espelho continuam lá até você apagá-las.

## 6. Assinatura de código (opcional)

Sem assinatura, o Windows mostra o SmartScreen e o macOS mostra o Gatekeeper; o tutorial explica como liberar. Para assinar, cadastre estes secrets em **Settings → Secrets and variables → Actions**:

| Secret | Uso |
|--------|-----|
| `MACOS_CERTIFICATE_P12_BASE64` | Certificado "Developer ID Application" (.p12) em base64 |
| `MACOS_CERTIFICATE_PASSWORD` | Senha do .p12 |
| `MACOS_SIGN_IDENTITY` | Ex.: `Developer ID Application: Nome (TEAMID)` |
| `APPLE_ID` | Apple ID usado na notarização |
| `APPLE_TEAM_ID` | Team ID da conta Apple Developer |
| `APPLE_APP_PASSWORD` | Senha de app (appleid.apple.com) para o `notarytool` |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | Certificado de assinatura de código (.pfx) em base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | Senha do .pfx |

Sem esses secrets, o release sai sem assinatura, que é o comportamento padrão.

## Pipelines (GitHub Actions) e custo

Em repositório privado os minutos do Actions são pagos depois da cota grátis (Windows conta 2×, macOS 10×). Por isso nada roda a cada push:

- **Em um pull request:** comente `/run all` (ou `/run ci`, `/run scripts`, `/run preflight`, `/run windows`). Só quem tem acesso de escrita ao repositório consegue disparar.
- **Uma vez por mês (dia 1º):** todas as pipelines rodam sozinhas.
- **Manual:** aba **Actions** → escolha o workflow → **Run workflow**, ou `gh workflow run windows.yml` (por padrão só no Windows Server 2025; para incluir o 2022: `gh workflow run windows.yml -f runners='["windows-latest","windows-2022"]'`).
- **Release:** continua automática ao criar uma tag `v*`.

Quando o repositório for público, dá para voltar os disparos em `push`/`pull_request` (Actions é grátis em repositório público).
