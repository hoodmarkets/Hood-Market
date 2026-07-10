import './networkDefaults.js';
import crypto from 'crypto';
import express from 'express';
import { config, validateConfig } from './config.js';
import { logger, formatStartupError } from './logger.js';
import { LiquidDeployer } from './deployer.js';
import { NeynarClient } from './neynar.js';
import { TelegramHandler } from './platforms/telegram.js';
import { FarcasterHandler } from './platforms/farcaster.js';
import { DiscordHandler } from './platforms/discord.js';
import { XWebhookHandler } from './platforms/x-webhook.js';
import { setPlatformListenSnapshot } from './lib/platformListenSnapshot.js';
import { postStartupListenReport } from './lib/discordDebug.js';
import { initDedupDb, closeDedupDb, cleanupOldRecords } from './lib/deployDedup.js';
import { initVanitySaltBankDb, closeVanitySaltBankDb, maintainVanitySaltBanks } from './lib/vanitySaltBank.js';
import { initDeploymentCatalogDb,
  closeDeploymentCatalogDb,
  runCatalogPurgesIfNeeded,
} from './lib/deploymentCatalog.js';
import { initHoodSocialDb, closeHoodSocialDb } from './lib/hoodSocialDb.js';
import { initPetitionDb, closePetitionDb } from './lib/petitionDb.js';
import { registerWebDeployRoutes } from './routes/deployWeb.js';
import { registerResolveSourceRoutes } from './routes/resolveSource.js';
import { registerDeploymentCatalogRoutes } from './routes/deploymentCatalog.js';
import { registerDeploymentFeedRoutes } from './routes/deploymentFeed.js';
import { registerTokenSwapRoutes } from './routes/tokenSwap.js';
import { registerTokenTradesRoutes } from './routes/tokenTrades.js';
import { registerVestingProxyRoutes } from './routes/vestingProxy.js';
import { registerMyDeploymentsRoutes } from './routes/myDeployments.js';
import { registerDeployerProfileRoutes } from './routes/deployerProfile.js';
import { registerUserProfileRoutes } from './routes/userProfile.js';
import { registerTokenSpaceRoutes } from './routes/tokenSpaces.js';
import { registerTokenPageBrandingRoutes } from './routes/tokenPageBranding.js';
import { registerTokenPageProfileRoutes } from './routes/tokenPageProfile.js';
import { registerMyDeploymentsClaimRoutes } from './routes/myDeploymentsClaim.js';
import { registerMyDeploymentsCollectPoolRoutes } from './routes/myDeploymentsCollectPool.js';
import { registerDeploymentFeeActionRoutes } from './routes/deploymentFeeActions.js';
import { registerFractionBuyerRewardRoutes } from './routes/fractionBuyerRewards.js';
import { startBuyerRewardPoller } from './lib/buyerRewardPoller.js';
import { registerFractionMetadataRoutes } from './routes/fractionMetadata.js';
import { registerAgentClaimCalldataRoutes } from './routes/agentClaimCalldata.js';
import { registerAgentClaimRoutes } from './routes/agentClaim.js';
import { registerAgentClaimForRecipientRoutes } from './routes/agentClaimForRecipient.js';
import { registerAgentCaptchaRoutes } from './routes/agentCaptcha.js';
import { registerZeroExSwapRoutes } from './routes/zeroexSwap.js';
import { registerBotSwapRoutes } from './routes/botSwap.js';
import { registerLangchainAgentRoutes } from './routes/langchainAgent.js';
import { registerAgentBankrRoutes } from './routes/agentBankr.js';
import { registerCatalogAdminRoutes } from './routes/catalogAdmin.js';
import { registerCommunityLaunchRoutes } from './routes/communityLaunch.js';
import { registerClientErrorReportRoutes } from './routes/clientErrorReport.js';
import { registerExploreRoutes } from './routes/explore.js';
import { registerWalletAuthRoutes } from './routes/walletAuth.js';
import { registerWebDeployCorsMiddleware } from './lib/webDeployCors.js';
import { initTokenMarketStatsDb, closeTokenMarketStatsDb } from './lib/tokenMarketStats.js';
import { startExploreStatsPoller } from './lib/exploreStatsPoller.js';

async function main() {
  try {
    // Initialize deploy dedup database + deployment catalog (same `.data` dir — use a volume in prod)
    initDedupDb();
    initDeploymentCatalogDb();
    initTokenMarketStatsDb();
    initVanitySaltBankDb();
    initHoodSocialDb();
    initPetitionDb();
    setTimeout(() => {
      void runCatalogPurgesIfNeeded(config.chainRpcUrl).catch((e: unknown) =>
        logger.warn('Catalog purge failed:', e instanceof Error ? e.message : e),
      );
    }, 3000);
    void cleanupOldRecords().catch((e: any) =>
      logger.warn('Deploy dedup cleanup failed:', e?.message)
    );

    // Validate config
    validateConfig();
    logger.info('Configuration validated');

    if (config.hoodmarketsV3.factory && config.webWalletDeployVanity) {
      setTimeout(() => {
        void maintainVanitySaltBanks().catch((e: unknown) =>
          logger.warn('Vanity salt bank maintenance failed:', e instanceof Error ? e.message : e),
        );
      }, 2000);
    }
    
    // Initialize services
    const deployer = new LiquidDeployer();
    const neynar = new NeynarClient();

    // Initialize platform handlers (skipped in WEB_ONLY_MODE unless tokens are set)
    const handlers: any[] = [];
    const startupErrors: string[] = [];
    let telegramListening = false;
    let discordListening = false;

    if (config.webOnlyMode) {
      logger.info('WEB_ONLY_MODE: API + Privy web deploy only (no bots)');
    }

    // Telegram
    if (!config.webOnlyMode && config.telegram.botToken) {
      try {
        const telegram = new TelegramHandler(deployer, neynar);
        handlers.push(telegram);
        telegramListening = true;
        logger.info('Telegram handler started');
      } catch (error: unknown) {
        const msg = formatStartupError(error);
        logger.error(`Failed to start Telegram: ${msg}`, error);
        startupErrors.push(`Telegram: ${msg}`);
      }
    }
    
    // Discord
    if (!config.webOnlyMode && config.discord.token) {
      try {
        const discord = new DiscordHandler(deployer, neynar);
        await discord.initialize();
        handlers.push(discord);
        discordListening = true;
        logger.info('Discord handler started');
      } catch (error: unknown) {
        const msg = formatStartupError(error);
        logger.error(`Failed to start Discord: ${msg}`, error);
        startupErrors.push(`Discord: ${msg}`);
      }
    }
    
    // Farcaster webhook handler
    let farcasterHandler: FarcasterHandler | null = null;
    if (!config.webOnlyMode && config.neynar.apiKey) {
      farcasterHandler = new FarcasterHandler(deployer, neynar);
      logger.info('Farcaster handler initialized');
    }

    // X (Twitter) — needs all OAuth1 credentials + webhook URL registered in developer portal
    let xHandler: XWebhookHandler | null = null;
    if (
      !config.webOnlyMode &&
      config.x.consumerKey &&
      config.x.consumerSecret &&
      config.x.accessToken &&
      config.x.accessTokenSecret
    ) {
      try {
        xHandler = new XWebhookHandler(deployer);
        logger.info('X webhook handler initialized');
      } catch (e: any) {
        logger.warn('X webhook handler not started:', e.message);
        startupErrors.push(`X: ${e.message}`);
      }
    }
    
    // Express server for webhooks
    const app = express();
    app.use(
      express.json({
        limit: '5mb',
        verify: (req: any, res, buf) => {
          req.rawBody = buf;
        },
      }),
    );

    registerWebDeployCorsMiddleware(app);

    // Health check
    app.get('/', (req, res) => {
      res.json({
        status: 'ok',
        service: config.webOnlyMode ? 'hood-markets-api' : 'liquid-social-launcher',
        webOnlyMode: config.webOnlyMode,
        platforms: {
          telegram: !!config.telegram.botToken,
          telegramDeploymentFeed: !!(config.telegram.botToken && config.telegram.feedChatId),
          discord: !!config.discord.token,
          farcaster: !!config.neynar.apiKey,
          x: !!xHandler,
          webDeploy: config.privy.enabled && config.webDeployCorsOrigins.length > 0,
        },
        timestamp: new Date().toISOString(),
      });
    });
    
    // Neynar webhook
    app.post('/webhooks/neynar', async (req, res) => {
      if (!farcasterHandler) {
        res.status(503).json({ error: 'Farcaster not enabled' });
        return;
      }
      
      try {
        await farcasterHandler.handleWebhook(req.body);
        res.json({ success: true });
      } catch (error: any) {
        logger.error('Neynar webhook error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // X — CRC challenge (required when saving webhook URL in X Developer Portal)
    app.get('/webhooks/x', (req, res) => {
      const crc = req.query.crc_token;
      if (typeof crc !== 'string' || !config.x.consumerSecret) {
        res.status(400).send('crc_token query or X_CONSUMER_SECRET missing');
        return;
      }
      const hmac = crypto
        .createHmac('sha256', config.x.consumerSecret)
        .update(crc)
        .digest('base64');
      res.status(200).json({ response_token: `sha256=${hmac}` });
    });

    app.post('/webhooks/x', async (req, res) => {
      if (!xHandler) {
        res.status(503).json({ error: 'X webhook not configured' });
        return;
      }
      try {
        await xHandler.handleWebhook(req.body);
        res.json({ success: true });
      } catch (error: any) {
        logger.error('X webhook error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    registerWebDeployRoutes(app, deployer, neynar);
    registerWalletAuthRoutes(app);
    registerAgentClaimCalldataRoutes(app);
    registerAgentClaimRoutes(app);
    registerAgentClaimForRecipientRoutes(app);
    registerResolveSourceRoutes(app, neynar);
    registerDeploymentCatalogRoutes(app);
    registerDeploymentFeedRoutes(app);
    registerExploreRoutes(app);
    registerDeploymentFeeActionRoutes(app);
    registerClientErrorReportRoutes(app);
    registerFractionBuyerRewardRoutes(app);
    registerFractionMetadataRoutes(app);
    registerTokenSwapRoutes(app);
    registerTokenTradesRoutes(app);
    registerVestingProxyRoutes(app);
    registerMyDeploymentsRoutes(app);
    registerDeployerProfileRoutes(app);
    registerUserProfileRoutes(app);
    registerTokenSpaceRoutes(app);
    registerTokenPageBrandingRoutes(app);
    registerTokenPageProfileRoutes(app);
    registerMyDeploymentsClaimRoutes(app);
    registerMyDeploymentsCollectPoolRoutes(app);
    registerAgentCaptchaRoutes(app);
    registerAgentBankrRoutes(app);
    registerCatalogAdminRoutes(app);
    registerCommunityLaunchRoutes(app);
    registerZeroExSwapRoutes(app);
    registerBotSwapRoutes(app);
    registerLangchainAgentRoutes(app);
    
    // Start server
    const port = config.port;
    app.listen(port, () => {
      logger.info(`🚀 Liquid Social Launcher running on port ${port}`);
      startBuyerRewardPoller();
      startExploreStatsPoller();
      logger.info(`Health: http://localhost:${port}/`);
      logger.info(`Neynar webhook: http://localhost:${port}/webhooks/neynar`);
      logger.info(`X webhook: http://localhost:${port}/webhooks/x`);
      logger.info(`Deployment catalog: GET http://localhost:${port}/api/deployments`);
      logger.info(`Deployment feed: GET http://localhost:${port}/api/feed/deployments`);
      logger.info(`Community Launch API: GET http://localhost:${port}/api/community-launch/config`);
      if (config.privy.enabled && config.webDeployCorsOrigins.length > 0) {
        logger.info(`Web deploy API: POST http://localhost:${port}/api/deploy`);
        logger.info(`Agent captcha challenge: GET http://localhost:${port}/api/agent-captcha/challenge`);
        logger.info(`Agent captcha verify: POST http://localhost:${port}/api/agent-captcha/verify`);
        logger.info(`Agent auto-claim: POST http://localhost:${port}/api/agent/claim`);
        logger.info(`Agent claim calldata: POST http://localhost:${port}/api/agent/claim-calldata`);
        logger.info(`Agent Bankr briefing: GET http://localhost:${port}/api/agent/briefing`);
        logger.info(`Agent prepare deploy/buy/sell: POST http://localhost:${port}/api/agent/prepare-deploy|prepare-buy|prepare-sell`);
        logger.info(`Agent buyer rewards: POST http://localhost:${port}/api/agent/prepare-fund-buyer-rewards|prepare-cancel-buyer-rewards`);
        logger.info(`Agent token discussion: GET http://localhost:${port}/api/agent/token-space-posts | POST http://localhost:${port}/api/agent/token-space-post`);
        logger.info(`Resolve source (prefill): POST http://localhost:${port}/api/resolve-source`);
        logger.info(`My deployments: GET http://localhost:${port}/api/my-deployments (auth)`);
        logger.info(`My deployment claim: POST http://localhost:${port}/api/my-deployments/claim (auth)`);
        logger.info(
          `My deployment collect pool fees: POST http://localhost:${port}/api/my-deployments/collect-pool-fees (auth)`,
        );
      }
      if (config.zeroX.enabled) {
        logger.info(`0x swap (proxied): GET http://localhost:${port}/api/swap/0x/price`);
        logger.info(`0x swap (proxied): GET http://localhost:${port}/api/swap/0x/quote`);
      }
      if (config.botSwap.apiSecret) {
        logger.info(`Bot delegated swap API: POST http://localhost:${port}/api/bot/swap (Bearer auth)`);
      }
      const langchainSecret =
        config.langchainAgent.apiSecret || config.botSwap.apiSecret;
      if (langchainSecret && config.langchainAgent.llmApiKey) {
        logger.info(
          `LangChain agent API: POST http://localhost:${port}/api/agent/langchain (Bearer auth, OPENAI_API_KEY)`,
        );
      }

      setPlatformListenSnapshot({
        httpServer: true,
        telegram: telegramListening,
        discord: discordListening,
        farcaster: !!farcasterHandler,
        x: !!xHandler,
        errors: startupErrors,
      });

      // X: legacy Account Activity push returns 410 — v2 user mentions polling drives deploy flow
      if (xHandler) {
        void xHandler.startMentionsPoller().catch((e: unknown) => {
          logger.error(
            'X mentions poller failed to start (unhandled async error — would crash the process without this catch)',
            e instanceof Error ? { message: e.message, stack: e.stack } : { detail: String(e) },
          );
        });
      }

      if (!config.webOnlyMode) {
        let reportAttempts = 0;
        const maxReportAttempts = 25;
        const scheduleStartupDiscordReport = (): void => {
          setTimeout(() => {
            void postStartupListenReport()
              .then((result) => {
                if (
                  result === 'pending_discord_client' &&
                  reportAttempts++ < maxReportAttempts
                ) {
                  scheduleStartupDiscordReport();
                }
              })
              .catch((e: unknown) => {
                logger.error(
                  'Startup Discord status report failed',
                  e instanceof Error ? { message: e.message, stack: e.stack } : { detail: String(e) },
                );
              });
          }, reportAttempts === 0 ? 1500 : 1000);
        };
        scheduleStartupDiscordReport();
      }
    });
    
  } catch (error: any) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  logger.error('Fatal: main() rejected', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

// Handle uncaught errors
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error('Unhandled rejection:', { message: msg, stack });
});

process.on('uncaughtException', (error: any) => {
  logger.error('Uncaught exception:', error);
  closeDedupDb();
  closeDeploymentCatalogDb();
  closeTokenMarketStatsDb();
  closeVanitySaltBankDb();
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM: shutting down gracefully');
  closeDedupDb();
  closeDeploymentCatalogDb();
  closeTokenMarketStatsDb();
  closeVanitySaltBankDb();
  closeHoodSocialDb();
  closePetitionDb();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT: shutting down gracefully');
  closeDedupDb();
  closeDeploymentCatalogDb();
  closeTokenMarketStatsDb();
  closeVanitySaltBankDb();
  closeHoodSocialDb();
  closePetitionDb();
  process.exit(0);
});
