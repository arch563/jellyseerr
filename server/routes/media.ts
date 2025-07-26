import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import JellyfinAPI from '@server/api/jellyfin';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type {
  MediaResultsResponse,
  MediaWatchDataResponse,
} from '@server/interfaces/api/mediaInterfaces';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import type { FindOneOptions } from 'typeorm';
import { In } from 'typeorm';
import { getHostname } from '@server/utils/getHostname';

const mediaRoutes = Router();

mediaRoutes.get('/', async (req, res, next) => {
  const mediaRepository = getRepository(Media);

  const pageSize = req.query.take ? Number(req.query.take) : 20;
  const skip = req.query.skip ? Number(req.query.skip) : 0;

  let statusFilter = undefined;

  switch (req.query.filter) {
    case 'available':
      statusFilter = MediaStatus.AVAILABLE;
      break;
    case 'partial':
      statusFilter = MediaStatus.PARTIALLY_AVAILABLE;
      break;
    case 'allavailable':
      statusFilter = In([
        MediaStatus.AVAILABLE,
        MediaStatus.PARTIALLY_AVAILABLE,
      ]);
      break;
    case 'processing':
      statusFilter = MediaStatus.PROCESSING;
      break;
    case 'pending':
      statusFilter = MediaStatus.PENDING;
      break;
    default:
      statusFilter = undefined;
  }

  let sortFilter: FindOneOptions<Media>['order'] = {
    id: 'DESC',
  };

  switch (req.query.sort) {
    case 'modified':
      sortFilter = {
        updatedAt: 'DESC',
      };
      break;
    case 'mediaAdded':
      sortFilter = {
        mediaAddedAt: 'DESC',
      };
  }

  try {
    const [media, mediaCount] = await mediaRepository.findAndCount({
      order: sortFilter,
      where: statusFilter && {
        status: statusFilter,
      },
      take: pageSize,
      skip,
    });
    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(mediaCount / pageSize),
        pageSize,
        results: mediaCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: media,
    } as MediaResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

/**
 * Add current user's metadata to a media item in Jellyfin
 * POST /api/v1/media/tag-user/:id
 */
mediaRoutes.post(
  '/tag-user/:id',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      logger.info('Add user tag endpoint called', {
        label: 'API',
        mediaId: req.params.id,
        userId: req.user?.id,
        method: req.method,
        url: req.url
      });

      const settings = getSettings();
      const mediaRepository = getRepository(Media);
      const userRepository = getRepository(User);

      // Check if Jellyfin is configured
      logger.info('Checking media server type', {
        label: 'API',
        mediaServerType: settings.main.mediaServerType,
        expectedTypes: [MediaServerType.JELLYFIN, MediaServerType.EMBY]
      });

      if (settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
        settings.main.mediaServerType !== MediaServerType.EMBY) {
        logger.warn('Media server type not supported for user tags', {
          label: 'API',
          mediaServerType: settings.main.mediaServerType
        });
        return res.status(400).json({
          message: 'This feature is only available with Jellyfin/Emby media servers.'
        });
      }

      // Get the requesting user
      const user = await userRepository.findOne({
        where: { id: req.user?.id },
        select: ['id', 'jellyfinUserId', 'jellyfinUsername', 'userType', 'username', 'plexUsername', 'email']
      });

      logger.info('User query result', {
        label: 'API',
        userId: req.user?.id,
        userFound: !!user,
        userDetails: user ? {
          id: user.id,
          userType: user.userType,
          jellyfinUserId: user.jellyfinUserId,
          hasJellyfinUsername: !!user.jellyfinUsername
        } : null
      });

      if (!user) {
        logger.warn('User not found', { label: 'API', userId: req.user?.id });
        return res.status(404).json({ message: 'User not found.' });
      }

      // Check if user is linked to Jellyfin/Emby
      logger.info('Checking user type and Jellyfin linking', {
        label: 'API',
        userType: user.userType,
        expectedTypes: [UserType.JELLYFIN, UserType.EMBY],
        jellyfinUserId: user.jellyfinUserId,
        hasJellyfinUserId: !!user.jellyfinUserId
      });

      if ((user.userType !== UserType.JELLYFIN && user.userType !== UserType.EMBY) || !user.jellyfinUserId) {
        logger.warn('User not linked to Jellyfin/Emby', {
          label: 'API',
          userType: user.userType,
          jellyfinUserId: user.jellyfinUserId
        });
        return res.status(400).json({
          message: 'User must be linked to Jellyfin/Emby to use this feature.'
        });
      }

      // Get the media item
      logger.info('Querying media item', {
        label: 'API',
        mediaId: req.params.id,
        mediaIdParsed: Number(req.params.id)
      });

      const media = await mediaRepository.findOne({
        where: { id: Number(req.params.id) }
      });

      logger.info('Media query result', {
        label: 'API',
        mediaId: req.params.id,
        mediaFound: !!media,
        status: media?.status,
        status4k: media?.status4k
      });

      if (!media) {
        logger.warn('Media not found', { label: 'API', mediaId: req.params.id });
        return res.status(404).json({ message: 'Media not found.' });
      }

      // Check if media is available (in library)
      if (media.status !== MediaStatus.AVAILABLE && media.status4k !== MediaStatus.AVAILABLE) {
        logger.warn('Media not available in library', {
          label: 'API',
          mediaId: media.id,
          status: media.status,
          status4k: media.status4k
        });
        return res.status(400).json({
          message: 'This feature is only available for media that exists in your library.'
        });
      }

      // Get admin user for Jellyfin API
      const admin = await userRepository.findOne({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId', 'jellyfinUserId']
      });

      if (!admin) {
        return res.status(500).json({ message: 'Admin user not found.' });
      }

      // Initialize Jellyfin API client
      const jellyfinClient = new JellyfinAPI(
        getHostname(),
        settings.jellyfin.apiKey,
        admin.jellyfinDeviceId ?? ''
      );
      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

      // Determine which Jellyfin media item to tag
      const jellyfinMediaId = media.jellyfinMediaId || media.jellyfinMediaId4k;

      if (!jellyfinMediaId) {
        return res.status(400).json({
          message: 'Media is not available in Jellyfin/Emby yet.'
        });
      }

      // Create user-specific tags for Jellyfin's filtering functionality
      const userTag = `jellyseerr-user-${user.jellyfinUserId}`;
      const displayName = user.username || user.plexUsername || user.jellyfinUsername || user.email;
      const userDisplayTag = `User: ${displayName}`;

      try {
        // Get the complete item data from Jellyfin (same as UI does)
        const itemData = await jellyfinClient.getItemData(jellyfinMediaId);

        if (!itemData) {
          return res.status(404).json({
            message: 'Media item not found in Jellyfin/Emby.'
          });
        }

        logger.info('Current item data retrieved from Jellyfin', {
          label: 'Media User Tag',
          itemId: jellyfinMediaId,
          currentTags: itemData.Tags || [],
          itemName: itemData.Name
        });

        // Get existing tags and add our user tag if it doesn't exist
        const existingTags = itemData.Tags || [];
        const newUserTag = userDisplayTag; // Use the display version: "User: John Doe"

        if (!existingTags.includes(newUserTag)) {
          const updatedTags = [...existingTags, newUserTag];

          // Update the complete item data with new tags - exactly like Jellyfin UI
          const updatedItemData = {
            ...itemData,
            Tags: updatedTags
          };

          logger.info('Updating Jellyfin item with new tag (full item approach)', {
            label: 'Media User Tag',
            itemId: jellyfinMediaId,
            oldTags: existingTags,
            newTags: updatedTags,
            userTag: newUserTag,
            itemName: itemData.Name,
            payloadSize: JSON.stringify(updatedItemData).length,
            payloadKeys: Object.keys(updatedItemData).slice(0, 10), // Show first 10 keys
            endpoint: `/Items/${jellyfinMediaId}`,
            method: 'POST',
            userId: admin.jellyfinUserId
          });

          // POST the complete item data back to Jellyfin (same as UI)
          await jellyfinClient.updateItemMetadata(jellyfinMediaId, updatedItemData);

          logger.info('Successfully updated Jellyfin item metadata with full item approach', {
            label: 'Media User Tag',
            userId: user.id,
            jellyfinUserId: user.jellyfinUserId,
            mediaId: media.id,
            jellyfinMediaId: jellyfinMediaId,
            addedTag: newUserTag
          });

          return res.status(200).json({
            message: 'User metadata tag added successfully to Jellyfin library.',
            tag: userTag,
            displayTag: userDisplayTag,
            jellyfinUserId: user.jellyfinUserId,
            mediaId: media.id,
            jellyfinMediaId: jellyfinMediaId,
            addedToLibrary: true
          });
        } else {
          logger.info('User tag already exists on media item', {
            label: 'Media User Tag',
            userId: user.id,
            mediaId: media.id,
            existingTag: newUserTag
          });

          return res.status(200).json({
            message: 'User metadata tag already exists on this media item.',
            tag: userTag,
            displayTag: userDisplayTag,
            jellyfinUserId: user.jellyfinUserId,
            mediaId: media.id,
            jellyfinMediaId: jellyfinMediaId,
            addedToLibrary: false
          });
        }

      } catch (error) {
        logger.error('Failed to process user tag request', {
          label: 'Media User Tag',
          error: error.message,
          userId: user.id,
          mediaId: media.id
        });

        return res.status(500).json({
          message: 'Failed to add user metadata tag.'
        });
      }

    } catch (error) {
      logger.error('Error in add user tag endpoint', {
        label: 'API',
        error: error.message
      });
      return next({
        status: 500,
        message: 'Internal server error.'
      });
    }
  }
);

mediaRoutes.post<
  {
    id: string;
    status: 'available' | 'partial' | 'processing' | 'pending' | 'unknown';
  },
  Media
>(
  '/:id/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const mediaRepository = getRepository(Media);
    const seasonRepository = getRepository(Season);

    const media = await mediaRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    const is4k = Boolean(req.body.is4k);

    switch (req.params.status) {
      case 'available':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;

        if (media.mediaType === MediaType.TV) {
          const expectedSeasons = req.body.seasons ?? [];

          for (const expectedSeason of expectedSeasons) {
            let season = media.seasons.find(
              (s) => s.seasonNumber === expectedSeason?.seasonNumber
            );

            if (!season) {
              // Create the season if it doesn't exist
              season = seasonRepository.create({
                seasonNumber: expectedSeason?.seasonNumber,
              });
              media.seasons.push(season);
            }

            season[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;
          }
        }
        break;
      case 'partial':
        if (media.mediaType === MediaType.MOVIE) {
          return next({
            status: 400,
            message: 'Only series can be set to be partially available',
          });
        }
        media.status = MediaStatus.PARTIALLY_AVAILABLE;
        break;
      case 'processing':
        media.status = MediaStatus.PROCESSING;
        break;
      case 'pending':
        media.status = MediaStatus.PENDING;
        break;
      case 'unknown':
        media.status = MediaStatus.UNKNOWN;
    }

    await mediaRepository.save(media);

    return res.status(200).json(media);
  }
);

mediaRoutes.delete(
  '/:id',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);

      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      await mediaRepository.remove(media);

      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong fetching media in delete request', {
        label: 'Media',
        message: e.message,
      });
      next({ status: 404, message: 'Media not found' });
    }
  }
);

mediaRoutes.delete(
  '/:id/file',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });
      const is4k = media.serviceUrl4k !== undefined;
      const isMovie = media.mediaType === MediaType.MOVIE;
      let serviceSettings;
      if (isMovie) {
        serviceSettings = settings.radarr.find(
          (radarr) => radarr.isDefault && radarr.is4k === is4k
        );
      } else {
        serviceSettings = settings.sonarr.find(
          (sonarr) => sonarr.isDefault && sonarr.is4k === is4k
        );
      }

      if (
        media.serviceId &&
        media.serviceId >= 0 &&
        serviceSettings?.id !== media.serviceId
      ) {
        if (isMovie) {
          serviceSettings = settings.radarr.find(
            (radarr) => radarr.id === media.serviceId
          );
        } else {
          serviceSettings = settings.sonarr.find(
            (sonarr) => sonarr.id === media.serviceId
          );
        }
      }
      if (!serviceSettings) {
        logger.warn(
          `There is no default ${is4k ? '4K ' : '' + isMovie ? 'Radarr' : 'Sonarr'
          }/ server configured. Did you set any of your ${is4k ? '4K ' : '' + isMovie ? 'Radarr' : 'Sonarr'
          } servers as default?`,
          {
            label: 'Media Request',
            mediaId: media.id,
          }
        );
        return;
      }
      let service;
      if (isMovie) {
        service = new RadarrAPI({
          apiKey: serviceSettings?.apiKey,
          url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
        });
      } else {
        service = new SonarrAPI({
          apiKey: serviceSettings?.apiKey,
          url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
        });
      }

      if (isMovie) {
        await (service as RadarrAPI).removeMovie(
          parseInt(
            is4k
              ? (media.externalServiceSlug4k as string)
              : (media.externalServiceSlug as string)
          )
        );
      } else {
        const tmdb = new TheMovieDb();
        const series = await tmdb.getTvShow({ tvId: media.tmdbId });
        const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;
        if (!tvdbId) {
          throw new Error('TVDB ID not found');
        }
        await (service as SonarrAPI).removeSerie(tvdbId);
      }

      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong fetching media in delete request', {
        label: 'Media',
        message: e.message,
      });
      next({ status: 404, message: 'Media not found' });
    }
  }
);

mediaRoutes.get<{ id: string }, MediaWatchDataResponse>(
  '/:id/watch_data',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    try {
      const tautulli = new TautulliAPI(settings);
      const userRepository = getRepository(User);

      const response: MediaWatchDataResponse = {};

      if (media.ratingKey) {
        const watchStats = await tautulli.getMediaWatchStats(media.ratingKey);
        const watchUsers = await tautulli.getMediaWatchUsers(media.ratingKey);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', {
            plexIds: watchUsers.map((u) => u.user_id),
          })
          .getMany();

        const playCount =
          watchStats.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data = {
          users: users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      if (media.ratingKey4k) {
        const watchStats4k = await tautulli.getMediaWatchStats(
          media.ratingKey4k
        );
        const watchUsers4k = await tautulli.getMediaWatchUsers(
          media.ratingKey4k
        );

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', {
            plexIds: watchUsers4k.map((u) => u.user_id),
          })
          .getMany();

        const playCount =
          watchStats4k.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats4k.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats4k.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data4k = {
          users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      return res.status(200).json(response);
    } catch (e) {
      logger.error('Something went wrong fetching media watch data', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch watch data.' });
    }
  }
);

export default mediaRoutes;
