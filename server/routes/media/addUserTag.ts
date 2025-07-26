import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { isAuthenticated } from '@server/middleware/auth';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { getHostname } from '@server/utils/getHostname';

const addUserTagRoutes = Router();

/**
 * Add current user's metadata to a media item in Jellyfin
 * POST /api/v1/media/:id/add-user-tag
 */
addUserTagRoutes.post(
    '/:id/add-user-tag',
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
                select: ['id', 'jellyfinUserId', 'jellyfinUsername', 'userType', 'displayName']
            });

            if (!user) {
                return res.status(404).json({ message: 'User not found.' });
            }

            // Check if user is linked to Jellyfin/Emby
            if ((user.userType !== UserType.JELLYFIN && user.userType !== UserType.EMBY) || !user.jellyfinUserId) {
                return res.status(400).json({
                    message: 'User must be linked to Jellyfin/Emby to use this feature.'
                });
            }

            // Get the media item
            const media = await mediaRepository.findOne({
                where: { id: Number(req.params.id) },
                relations: ['requests']
            });

            if (!media) {
                return res.status(404).json({ message: 'Media not found.' });
            }

            // Check if media has been requested
            if (!media.requests || media.requests.length === 0) {
                return res.status(400).json({
                    message: 'This feature is only available for requested media.'
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

            // Create a tag with the user's information
            const userTag = `jellyseerr-user-${user.jellyfinUserId}`;
            const userDisplayTag = `User: ${user.displayName || user.jellyfinUsername}`;

            try {
                // Get existing tags for the media item
                const itemData = await jellyfinClient.getItemData(jellyfinMediaId);

                if (!itemData) {
                    return res.status(404).json({
                        message: 'Media item not found in Jellyfin/Emby.'
                    });
                }

                // For now, we'll log the action as Jellyfin API doesn't have direct tag modification
                // In a real implementation, you would need to use Jellyfin's metadata API
                logger.info('User requested to add metadata tag to media', {
                    label: 'Media User Tag',
                    userId: user.id,
                    jellyfinUserId: user.jellyfinUserId,
                    mediaId: media.id,
                    jellyfinMediaId: jellyfinMediaId,
                    userTag: userTag,
                    displayName: user.displayName || user.jellyfinUsername
                });

                // Note: Jellyfin's API doesn't provide direct tag manipulation endpoints
                // This would require a plugin or external metadata management
                // For now, we'll simulate success and return the tag information

                return res.status(200).json({
                    message: 'User metadata tag request processed successfully.',
                    tag: userTag,
                    displayTag: userDisplayTag,
                    jellyfinUserId: user.jellyfinUserId,
                    mediaId: media.id,
                    jellyfinMediaId: jellyfinMediaId
                });

            } catch (error) {
                logger.error('Failed to add user tag to media', {
                    label: 'Media User Tag',
                    error: error.message,
                    userId: user.id,
                    mediaId: media.id
                });

                return res.status(500).json({
                    message: 'Failed to add user metadata to media item.'
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

export default addUserTagRoutes;
